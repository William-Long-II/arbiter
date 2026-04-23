import { existsSync, readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Store } from "./state/db.ts";
import { DEFAULT_EXCLUDE_PATHS } from "./review/file-filter.ts";

const ToneMode = z.enum(["append", "replace"]);
export type ToneMode = z.infer<typeof ToneMode>;

const OrgWatch = z
  .object({
    name: z.string().min(1),
    mode: z.enum(["all", "include"]).default("all"),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    tone_override: z.string().nullable().default(null),
    tone_mode: ToneMode.default("append"),
  })
  .refine((v) => v.mode !== "include" || v.include.length > 0, {
    message: "orgs[].include must be non-empty when mode is 'include'",
  });

/**
 * A repo entry is either a bare "owner/name" string (legacy YAML form) or an
 * object with a slug plus tone fields. Preprocess normalizes the string form
 * into an object so the rest of the app sees a single shape.
 */
const RepoEntry = z.preprocess(
  (v) => (typeof v === "string" ? { slug: v } : v),
  z.object({
    slug: z.string().regex(/^[^/]+\/[^/]+$/, "repos[] must be 'owner/name'"),
    tone_override: z.string().nullable().default(null),
    tone_mode: ToneMode.default("append"),
  }),
);

export const ConfigSchema = z.object({
  github: z.object({
    // GitHub logins: 1-39 chars, alphanumeric + hyphen, no consecutive
    // hyphens, can't start with one. "" is allowed because the first-boot
    // state has no bot yet; isConfigured() checks separately.
    bot_username: z
      .string()
      .max(39)
      .refine(
        (s) => s === "" || /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s),
        { message: "must be a valid GitHub login (1-39 chars, alphanumeric + hyphens)" },
      )
      .default(""),
    skip_authors: z.array(z.string().min(1).max(39)).max(200).default([]),
    /**
     * GitHub OAuth App client id for multi-user session login (#137).
     * Stored in the DB so operators can manage it from the UI. The
     * matching client_secret stays in env (GITHUB_OAUTH_CLIENT_SECRET)
     * because it must not appear in a DB snapshot.
     */
    oauth_client_id: z.string().max(200).default(""),
  }),
  watch: z.object({
    orgs: z.array(OrgWatch).default([]),
    repos: z.array(RepoEntry).default([]),
  }),
  review: z.object({
    dry_run: z.boolean().default(true),
    max_approvals_per_hour: z.number().int().positive().max(1000).default(10),
    // Tone is concatenated into every Claude prompt. Cap to keep a runaway
    // paste from blowing up prompt budget across many concurrent reviews.
    tone: z.string().max(10_000).default(
      "Be constructive and specific. Explain WHY and HOW for every issue.",
    ),
    skip_drafts: z.boolean().default(true),
    skip_bots: z.boolean().default(true),
    require_ci_green: z.boolean().default(true),
    /**
     * How many PRs to review in parallel.
     * Default 1 (fully serial, original behavior). Max 4 is enforced because
     * the Claude Max subscription is sized for interactive use, not high
     * concurrency; a single session pushed too hard can trigger a 5-hour
     * cooldown from which there is no recovery except waiting.
     */
    concurrency: z.number().int().min(1).max(4).default(1),
    /**
     * Per-PR failure threshold. After this many consecutive review failures
     * on the same (repo, pr, head_sha), the PR is dead-lettered: skipped by
     * normal discovery and surfaced on the Dashboard's "Needs attention"
     * card for operator action (retry or dismiss). Set to 0 to disable
     * dead-lettering (PRs retry every tick regardless).
     */
    dead_letter_threshold: z.number().int().min(0).max(20).default(3),
    /**
     * Large-PR triage activates above either threshold. When it does, a
     * lightweight first-pass classifies every file; only the top
     * `large_pr_deep_review_files` get the full review prompt. Rest are
     * summarized as deferred. Two Claude calls per large PR (triage +
     * review) regardless of total file count.
     *
     * Set fileCount or diffBytes very high to effectively disable triage.
     */
    large_pr_threshold_files: z.number().int().min(5).max(500).default(25),
    large_pr_threshold_bytes: z.number().int().min(10_000).max(10_000_000).default(100_000),
    large_pr_deep_review_files: z.number().int().min(1).max(50).default(15),
    /**
     * When true, the loop checks each reviewed PR for new replies to the
     * bot's line comments and iterates the conversation (#136). Off by
     * default — it costs an extra Claude call per pending thread and
     * roughly-one `GET /pulls/:n/comments` per PR per tick, which is
     * wasted work when the operator isn't using the feature.
     */
    threaded_replies: z.boolean().default(false),
    /**
     * How many previously-reviewed PRs to scan per tick for new replies.
     * Polling all reviewed PRs is expensive; scanning the most recent N
     * catches active conversations without unbounded work. Tune up if
     * slow-moving discussions go unanswered.
     */
    threaded_replies_scan_recent: z.number().int().min(1).max(200).default(25),
    /**
     * Glob-list filters applied to the diff before Claude sees it.
     * include_paths empty = every file passes the include check. Non-empty
     * acts as a whitelist. exclude_paths drops any match after include.
     * Both accept Bun.Glob (minimatch-compatible) patterns. Per-entry cap
     * stops ridiculous patterns; list cap stops someone pasting a repo's
     * entire find-tree output into the textarea.
     */
    include_paths: z.array(z.string().min(1).max(500)).max(200).default([]),
    exclude_paths: z.array(z.string().min(1).max(500)).max(200).default([]),
  }),
  poll: z.object({
    interval_seconds: z.number().int().positive().default(60),
  }),
  claude: z.object({
    command: z.string().default("claude"),
    timeout_seconds: z.number().int().positive().default(600),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type OrgWatchEntry = z.infer<typeof OrgWatch>;

/** A single validation failure tied to a dotted field path. */
export type FieldError = { path: string; message: string };

/**
 * Validate a candidate config at SAVE time, before it hits the DB. Returns
 * the parsed Config on success, or a list of field-scoped error messages
 * on failure. Prevents the "save a broken tone, next tick crashes" path.
 */
export function validateConfig(
  candidate: unknown,
): { ok: true; cfg: Config } | { ok: false; errors: FieldError[] } {
  const r = ConfigSchema.safeParse(candidate);
  if (r.success) return { ok: true, cfg: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => ({
      path: i.path.join(".") || "<root>",
      message: i.message,
    })),
  };
}

/** Whether the config is sufficient for the loop to run. */
export function isConfigured(cfg: Config): boolean {
  if (!cfg.github.bot_username) return false;
  if (cfg.watch.orgs.length + cfg.watch.repos.length === 0) return false;
  return true;
}

/** Full list of scalar keys persisted in config_scalars. Edit-one-place for UI rendering. */
export const SCALAR_DEFAULTS: Record<string, string> = {
  "github.bot_username": "",
  "github.oauth_client_id": "",
  "review.dry_run": "true",
  "review.max_approvals_per_hour": "10",
  "review.tone":
    "Be constructive and specific. Explain WHY and HOW for every issue.",
  "review.skip_drafts": "true",
  "review.skip_bots": "true",
  "review.require_ci_green": "true",
  "review.concurrency": "1",
  "review.dead_letter_threshold": "3",
  "review.large_pr_threshold_files": "25",
  "review.large_pr_threshold_bytes": "100000",
  "review.large_pr_deep_review_files": "15",
  "review.threaded_replies": "false",
  "review.threaded_replies_scan_recent": "25",
  "review.include_paths": "[]",
  "review.exclude_paths": JSON.stringify(DEFAULT_EXCLUDE_PATHS),
  "poll.interval_seconds": "60",
  "claude.command": "claude",
  "claude.timeout_seconds": "600",
};

export function loadConfigFromStore(store: Store): Config {
  const scalars = { ...SCALAR_DEFAULTS, ...store.allScalars() };
  const orgs = store.listOrgs().map((r) => ({
    name: r.name,
    mode: r.mode,
    include: safeJsonArray(r.include_json),
    exclude: safeJsonArray(r.exclude_json),
    tone_override: r.tone_override,
    tone_mode: r.tone_mode,
  }));
  const repos = store.listWatchedRepoRows().map((r) => ({
    slug: r.slug,
    tone_override: r.tone_override,
    tone_mode: r.tone_mode,
  }));

  const raw = {
    github: {
      bot_username: scalars["github.bot_username"] ?? "",
      skip_authors: store.listSkipAuthors(),
      oauth_client_id: scalars["github.oauth_client_id"] ?? "",
    },
    watch: {
      orgs,
      repos,
    },
    review: {
      dry_run: asBool(scalars["review.dry_run"], true),
      max_approvals_per_hour: asInt(scalars["review.max_approvals_per_hour"], 10),
      tone: scalars["review.tone"] ?? "",
      skip_drafts: asBool(scalars["review.skip_drafts"], true),
      skip_bots: asBool(scalars["review.skip_bots"], true),
      require_ci_green: asBool(scalars["review.require_ci_green"], true),
      concurrency: asInt(scalars["review.concurrency"], 1),
      dead_letter_threshold: asInt(scalars["review.dead_letter_threshold"], 3),
      large_pr_threshold_files: asInt(scalars["review.large_pr_threshold_files"], 25),
      large_pr_threshold_bytes: asInt(scalars["review.large_pr_threshold_bytes"], 100_000),
      large_pr_deep_review_files: asInt(scalars["review.large_pr_deep_review_files"], 15),
      threaded_replies: asBool(scalars["review.threaded_replies"], false),
      threaded_replies_scan_recent: asInt(scalars["review.threaded_replies_scan_recent"], 25),
      include_paths: safeJsonArray(scalars["review.include_paths"] ?? "[]"),
      exclude_paths: safeJsonArray(scalars["review.exclude_paths"] ?? "[]"),
    },
    poll: {
      interval_seconds: asInt(scalars["poll.interval_seconds"], 60),
    },
    claude: {
      command: scalars["claude.command"] ?? "claude",
      timeout_seconds: asInt(scalars["claude.timeout_seconds"], 600),
    },
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config in store:\n${issues}`);
  }
  return result.data;
}

/**
 * If the DB has no bot_username AND a config.yaml file exists, import it once.
 * Returns true if bootstrap happened (caller can surface in UI / events).
 */
export function bootstrapFromYaml(store: Store, yamlPath: string): boolean {
  if (store.getScalar("github.bot_username")) return false;
  if (!existsSync(yamlPath)) return false;
  // If the path exists but isn't a regular file, skip cleanly instead of
  // crashing with EISDIR. This is common when Docker bind-mounts a host
  // path that doesn't exist: dockerd creates a directory at the mount
  // target, and the previous `existsSync && readFileSync` path exploded
  // on the first-boot attempt to read the "file".
  try {
    if (!statSync(yamlPath).isFile()) return false;
  } catch {
    return false;
  }

  const raw = parseYaml(readFileSync(yamlPath, "utf8"));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `config.yaml bootstrap failed:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
    );
  }
  const cfg = parsed.data;

  store.setScalar("github.bot_username", cfg.github.bot_username);
  store.setScalar("github.oauth_client_id", cfg.github.oauth_client_id);
  store.setScalar("review.dry_run", String(cfg.review.dry_run));
  store.setScalar("review.max_approvals_per_hour", String(cfg.review.max_approvals_per_hour));
  store.setScalar("review.tone", cfg.review.tone);
  store.setScalar("review.skip_drafts", String(cfg.review.skip_drafts));
  store.setScalar("review.skip_bots", String(cfg.review.skip_bots));
  store.setScalar("review.require_ci_green", String(cfg.review.require_ci_green));
  store.setScalar("review.concurrency", String(cfg.review.concurrency));
  store.setScalar("review.dead_letter_threshold", String(cfg.review.dead_letter_threshold));
  store.setScalar("review.large_pr_threshold_files", String(cfg.review.large_pr_threshold_files));
  store.setScalar("review.large_pr_threshold_bytes", String(cfg.review.large_pr_threshold_bytes));
  store.setScalar("review.large_pr_deep_review_files", String(cfg.review.large_pr_deep_review_files));
  store.setScalar("review.threaded_replies", String(cfg.review.threaded_replies));
  store.setScalar("review.threaded_replies_scan_recent", String(cfg.review.threaded_replies_scan_recent));
  store.setScalar("review.include_paths", JSON.stringify(cfg.review.include_paths));
  store.setScalar("review.exclude_paths", JSON.stringify(cfg.review.exclude_paths));
  store.setScalar("poll.interval_seconds", String(cfg.poll.interval_seconds));
  store.setScalar("claude.command", cfg.claude.command);
  store.setScalar("claude.timeout_seconds", String(cfg.claude.timeout_seconds));

  for (const a of cfg.github.skip_authors) store.addSkipAuthor(a);
  for (const r of cfg.watch.repos) {
    store.addWatchedRepo(r.slug);
    if (r.tone_override !== null || r.tone_mode !== "append") {
      store.setRepoTone(r.slug, r.tone_override, r.tone_mode);
    }
  }
  for (const o of cfg.watch.orgs) {
    store.upsertOrg({
      name: o.name,
      mode: o.mode,
      include_json: JSON.stringify(o.include),
      exclude_json: JSON.stringify(o.exclude),
      tone_override: o.tone_override,
      tone_mode: o.tone_mode,
    });
  }

  return true;
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function asBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function asInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : fallback;
}
