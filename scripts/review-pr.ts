#!/usr/bin/env bun
/**
 * Dry-run CLI: inspect what review-me would do against a live PR without
 * posting a review or calling the LLM (unless explicitly requested).
 *
 * Usage:
 *   bun run review-pr <owner>/<repo>#<pr> [--with-llm] [--post]
 *
 * Modes:
 *   (no flags)   — dry-run: fetch PR data, build user message, print it.
 *                  No Anthropic call. No GitHub write.
 *   --with-llm   — additionally call Anthropic (single-pass only; exits non-zero
 *                  if the diff exceeds the chunked threshold).
 *   --post       — post the review to GitHub. Implies --with-llm.
 *
 * Security note: the user message printed to stdout may contain PR content
 * (title, body, diff). Do not pipe to untrusted consumers or log in shared
 * environments. The ANTHROPIC_API_KEY used here is always the process-level
 * default — per-repo key overrides (anthropic_api_key_env in repos.yaml) are
 * intentionally ignored so a debug run never burns a team's quota.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "../src/github/client";
import { createOctokit } from "../src/github/client";
import { fetchPullRequestDiff } from "../src/github/diff";
import { fetchGitattributes } from "../src/github/gitattributes";
import { postReview } from "../src/github/review";
import { createAnthropic } from "../src/review/client";
import { fetchConventions } from "../src/review/conventions";
import { filterDiff } from "../src/review/diff-filter";
import { computeCoverageDelta } from "../src/review/coverage-delta";
import { applicableHeuristics } from "../src/review/heuristics/index";
import { buildUserMessage } from "../src/review/prompt";
import { runReview } from "../src/review/index";
import { toFileDiffs, planReview, DEFAULT_BATCH_BUDGET_CHARS } from "../src/review/chunker";
import { resolveIntent } from "../src/jira/index";
import { loadAllowlist } from "../src/config/index";
import { buildAllowlist } from "../src/config/repos";
import type { RepoReviewConfig } from "../src/config/repos";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DryRunRef = {
  owner: string;
  repo: string;
  prNumber: number;
};

export type DryRunOptions = {
  ref: DryRunRef;
  withLlm?: boolean;
  post?: boolean;
  /** Injected Octokit for testing. When absent the real client is used. */
  octokit?: Octokit;
  /** Injected Anthropic client for testing. When absent the real client is used
   *  (only when --with-llm or --post is set). */
  anthropic?: Anthropic;
  /** Output stream — defaults to process.stdout. */
  stdout?: { write(s: string): void };
};

export type DryRunResult = {
  userMessage: string;
  promptBytes: number;
  omittedCount: number;
  coverageDelta: { addedSrcLines: number; addedTestLines: number; ratio: number };
  intentSource: string;
  intentRef: string | undefined;
  chunkerBatches: number;
  chunkSizes: number[];
  llmResult?: unknown;
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs = {
  ref: DryRunRef;
  withLlm: boolean;
  post: boolean;
};

const USAGE = [
  "Usage: bun run review-pr <owner>/<repo>#<pr> [--with-llm] [--post]",
  "",
  "  <owner>/<repo>#<pr>  e.g. acme/widget#42",
  "  --with-llm           call Anthropic and print structured result",
  "  --post               post the review (implies --with-llm)",
  "",
  "No flags = dry-run: no Anthropic call, no GitHub write.",
].join("\n");

export function parseArgs(argv: string[]): ParsedArgs {
  // argv is process.argv.slice(2) — first element is the positional ref
  const positionals = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));

  if (positionals.length !== 1) {
    throw new ArgError("Expected exactly one positional argument: <owner>/<repo>#<pr>");
  }

  const raw = positionals[0]!;
  // Match owner/repo#pr (owner may contain hyphens/dots, repo similar)
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(raw);
  if (!m) {
    throw new ArgError(`Invalid ref format "${raw}". Expected owner/repo#<number>`);
  }

  const [, owner, repo, prStr] = m;
  const prNumber = parseInt(prStr!, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    throw new ArgError(`Invalid PR number "${prStr}"`);
  }

  const unknownFlags = [...flags].filter((f) => f !== "--with-llm" && f !== "--post");
  if (unknownFlags.length > 0) {
    throw new ArgError(`Unknown flag(s): ${unknownFlags.join(", ")}`);
  }

  const post = flags.has("--post");
  const withLlm = flags.has("--with-llm") || post;

  return {
    ref: { owner: owner!, repo: repo!, prNumber },
    withLlm,
    post,
  };
}

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective review config for a repo.
 *
 * Falls back to built-in defaults (no include/exclude path filters) when the
 * repo is not in the allowlist. This lets operators run the CLI against any
 * repo without pre-configuring it.
 */
function resolveReviewConfig(
  allowlist: ReturnType<typeof buildAllowlist>,
  fullName: string,
): RepoReviewConfig | undefined {
  const cfg = allowlist.getEffectiveConfig(fullName);
  return cfg?.review;
}

export async function runDryRun(opts: DryRunOptions): Promise<DryRunResult> {
  const { ref, withLlm = false, post = false } = opts;
  const out = opts.stdout ?? process.stdout;

  function print(s: string): void {
    out.write(s + "\n");
  }

  const fullName = `${ref.owner}/${ref.repo}`;

  // -------------------------------------------------------------------------
  // 1. Config — load repos.yaml if it exists; otherwise use empty allowlist.
  //    We deliberately do NOT call loadConfig() which requires all env vars;
  //    the CLI only needs GITHUB_PAT (for GitHub reads) and optionally
  //    ANTHROPIC_API_KEY (for --with-llm). Those are validated below.
  // -------------------------------------------------------------------------
  let reposPath = process.env["REPOS_PATH"] ?? "./repos.yaml";
  let allowlist: ReturnType<typeof buildAllowlist>;
  try {
    const result = loadAllowlist(reposPath);
    allowlist = result as ReturnType<typeof buildAllowlist>;
  } catch {
    // If repos.yaml doesn't exist or fails to parse, use an empty allowlist
    // so built-in defaults apply.
    allowlist = buildAllowlist({});
  }

  const reviewConfig = resolveReviewConfig(allowlist, fullName);

  // -------------------------------------------------------------------------
  // 2. Clients
  // -------------------------------------------------------------------------
  const octokit =
    opts.octokit ??
    (() => {
      const pat = process.env["GITHUB_PAT"];
      if (!pat) {
        throw new Error("GITHUB_PAT environment variable is required");
      }
      return createOctokit(pat);
    })();

  // Anthropic client is created lazily (only when --with-llm or --post).
  // We deliberately ignore per-repo anthropic_api_key_env so this CLI always
  // uses the operator's own key, never a team's key, for safety.
  let anthropic: Anthropic | undefined = opts.anthropic;

  // -------------------------------------------------------------------------
  // 3. Fetch PR diff + conventions + .gitattributes in parallel
  // -------------------------------------------------------------------------
  print(`Fetching PR ${fullName}#${ref.prNumber} ...`);

  const [diff, conventions, gitattributes] = await Promise.all([
    fetchPullRequestDiff(octokit, ref.owner, ref.repo, ref.prNumber),
    fetchConventions({
      octokit,
      owner: ref.owner,
      repo: ref.repo,
      ref: "HEAD",
    }),
    fetchGitattributes({
      octokit,
      owner: ref.owner,
      repo: ref.repo,
      ref: "HEAD",
    }),
  ]);

  // -------------------------------------------------------------------------
  // 4. Resolve intent
  // -------------------------------------------------------------------------
  const jiraCredentials =
    process.env["JIRA_BASE_URL"] &&
    process.env["JIRA_EMAIL"] &&
    process.env["JIRA_API_TOKEN"]
      ? {
          baseUrl: process.env["JIRA_BASE_URL"]!,
          email: process.env["JIRA_EMAIL"]!,
          apiToken: process.env["JIRA_API_TOKEN"]!,
        }
      : undefined;

  const intent = await resolveIntent({
    prTitle: diff.title,
    prBody: diff.body,
    // Branch name is not returned by the diff fetch; use empty string so the
    // intent resolver still works (it falls back to title/body extraction).
    branch: "",
    creds: jiraCredentials,
    // Cast through unknown: the real Octokit returns body?: string|null|undefined
    // but IssueClient expects string|null. The runtime value is always string|null.
    octokit: octokit as unknown as import("../src/jira/providers/github-issue").IssueClient,
    repoOwner: ref.owner,
    repoName: ref.repo,
  });

  // -------------------------------------------------------------------------
  // 5. Filter diff
  // -------------------------------------------------------------------------
  const filterResult = filterDiff(diff.files, {
    include: reviewConfig?.include_paths,
    exclude: reviewConfig?.exclude_paths,
    gitattributes: gitattributes ?? undefined,
  });

  // -------------------------------------------------------------------------
  // 6. Coverage delta + heuristics (on kept files only)
  // -------------------------------------------------------------------------
  const omittedPathSet = new Set(filterResult.omitted.map((o) => o.path));
  const keptFiles = diff.files.filter((f) => !omittedPathSet.has(f.filename));

  const coverageDelta = computeCoverageDelta(keptFiles);
  const heuristics = applicableHeuristics(keptFiles);

  // -------------------------------------------------------------------------
  // 7. Build user message
  // -------------------------------------------------------------------------
  const userMessage = buildUserMessage({
    intent,
    diff,
    conventions,
    filterResult,
    coverageDelta,
    heuristics,
  });

  const promptBytes = Buffer.byteLength(userMessage, "utf8");

  // -------------------------------------------------------------------------
  // 8. Chunker plan
  // -------------------------------------------------------------------------
  const fileDiffs = toFileDiffs(keptFiles);
  const plan = planReview(fileDiffs, DEFAULT_BATCH_BUDGET_CHARS);
  const chunkSizes = plan.batches.map((batch) =>
    batch.reduce((sum, f) => sum + f.patch.length, 0),
  );

  // -------------------------------------------------------------------------
  // 9. Print banner + message + summary
  // -------------------------------------------------------------------------
  print("");
  print("===== USER MESSAGE (dry-run) =====");
  print(userMessage);
  print("===== END USER MESSAGE =====");
  print("");
  print("--- Summary ---");
  print(`PR:             ${fullName}#${ref.prNumber} @ ${diff.headSha.slice(0, 12)}`);
  print(`PR title:       ${diff.title}`);
  print(`Files changed:  ${diff.totals.changedFiles} (kept: ${keptFiles.length}, omitted: ${filterResult.omitted.length})`);
  if (filterResult.omitted.length > 0) {
    const omittedPaths = filterResult.omitted.map((o) => `  - ${o.path} (${o.reason})`).join("\n");
    print(`Omitted files:\n${omittedPaths}`);
  }
  print(`Coverage delta: +${coverageDelta.addedSrcLines} src lines, +${coverageDelta.addedTestLines} test lines (ratio: ${coverageDelta.ratio.toFixed(2)})`);
  print(`Intent source:  ${intent.source}${intent.ticketKey ? ` (${intent.ticketKey})` : ""}`);
  print(`Prompt size:    ${promptBytes.toLocaleString()} bytes`);
  print(`Chunker plan:   ${plan.batches.length} batch(es) — sizes: [${chunkSizes.join(", ")}] chars`);

  // -------------------------------------------------------------------------
  // 10. --with-llm path
  // -------------------------------------------------------------------------
  let llmResult: unknown | undefined;

  if (withLlm || post) {
    // Check whether the diff would require chunked mode. Dry-run single-pass only.
    const { DEFAULT_MAX_DIFF_CHARS } = await import("../src/review/index");
    const diffSize = keptFiles.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);

    if (plan.batches.length > 1) {
      const msg =
        `--with-llm: diff exceeds single-pass threshold ` +
        `(${diffSize.toLocaleString()} chars across ${plan.batches.length} batches). ` +
        `Chunked mode is not supported in dry-run. ` +
        `Split your review or remove --with-llm.`;
      print(`\nERROR: ${msg}`);
      process.exit(1);
    }

    if (!anthropic) {
      const key = process.env["ANTHROPIC_API_KEY"];
      if (!key) {
        throw new Error("ANTHROPIC_API_KEY environment variable is required for --with-llm");
      }
      anthropic = createAnthropic(key);
    }

    print("\nCalling Anthropic (single-pass) ...");

    const reviewOutput = await runReview(anthropic, {
      intent,
      diff,
      octokit,
      reviewConfig,
    });

    llmResult = reviewOutput.result;

    print("");
    print("===== LLM RESULT =====");
    print(JSON.stringify(reviewOutput.result, null, 2));
    print("===== END LLM RESULT =====");

    if (reviewOutput.warnings.length > 0) {
      print(`\nWarnings:\n${reviewOutput.warnings.map((w) => `  - ${w}`).join("\n")}`);
    }

    if (reviewOutput.traceMetadata) {
      const tm = reviewOutput.traceMetadata;
      print(`\nTrace: model=${tm.model} mode=${tm.mode} promptHash=${tm.promptHash}`);
    }

    // -----------------------------------------------------------------------
    // 11. --post path
    // -----------------------------------------------------------------------
    if (post) {
      const selfLogin = process.env["GITHUB_MACHINE_USER_LOGIN"] ?? "review-me-bot";
      print(`\nPosting review as ${selfLogin} ...`);

      const outcome = await postReview(octokit, {
        owner: ref.owner,
        repo: ref.repo,
        pullNumber: ref.prNumber,
        headSha: diff.headSha,
        selfLogin,
        review: reviewOutput.result,
        traceMetadata: reviewOutput.traceMetadata,
      });

      print(`\nPost outcome: ${JSON.stringify(outcome, null, 2)}`);
    }
  }

  return {
    userMessage,
    promptBytes,
    omittedCount: filterResult.omitted.length,
    coverageDelta: {
      addedSrcLines: coverageDelta.addedSrcLines,
      addedTestLines: coverageDelta.addedTestLines,
      ratio: coverageDelta.ratio,
    },
    intentSource: intent.source,
    intentRef: intent.ticketKey,
    chunkerBatches: plan.batches.length,
    chunkSizes,
    llmResult,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`Error: ${err.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    throw err;
  }

  runDryRun({
    ref: parsed.ref,
    withLlm: parsed.withLlm,
    post: parsed.post,
  })
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal: ${message}\n`);
      process.exit(1);
    });
}
