import type { FileDiff, PrContext } from "../github/diff.ts";
import type { TicketContext } from "../intent/types.ts";

/**
 * Per-ticket body is capped so a novella on a linked issue can't crowd out
 * the diff. Reviewers should see enough intent to ground the review; they
 * don't need every paragraph.
 */
const MAX_TICKET_BODY_CHARS = 2000;

/**
 * Reply prompt — used by the threaded-iteration path (#136). Claude has
 * already posted a review on this PR; a human replied to one of its
 * line comments and now expects a direct response. We feed the full
 * comment chain, the file diff at the affected path, and the tone.
 *
 * Output is a single-field JSON object with the reply body. Kept
 * deliberately narrow (no verdict, no additional comments) so the
 * prompt has no incentive to escalate into posting more surface area.
 */
export function buildReplyPrompt(args: {
  repo: string;
  pullNumber: number;
  tone: string;
  /** The file path this thread is attached to. Included so Claude can
   *  ground its answer in the specific diff, not just the comment text. */
  path: string;
  /** The diff body for that path (GitHub's patch format). When absent
   *  (e.g. the file was later removed from the PR), we skip this block. */
  patch: string | undefined;
  /** Ordered chain: bot's original comment first, then every reply in
   *  chronological order. Each block labels the author so Claude can
   *  see who said what without reconstructing it from context clues. */
  chain: Array<{ author: string; body: string }>;
}): string {
  const chainBlock = args.chain
    .map((m, i) => `[${i === 0 ? "you (original comment)" : m.author}]\n${m.body}`)
    .join("\n\n---\n\n");

  const diffBlock = args.patch
    ? `\n\nDIFF (${args.path}):\n${args.patch}`
    : `\n\n(The file ${args.path} is no longer in the PR diff; respond from the thread context alone.)`;

  return `You are continuing a review conversation on pull request ${args.repo}#${args.pullNumber}.

You posted the first comment in the thread below. A human replied. Respond to the most recent reply directly, grounded in the diff you originally commented on.

REVIEW TONE:
${args.tone}

CONVERSATION (most recent reply is last):
${chainBlock}${diffBlock}

TASK:
Write a single reply. Your output MUST be a single JSON object on stdout and NOTHING else — no prose before or after, no markdown fences.

JSON schema:
{
  "reply": "Plain text. 1-6 sentences, markdown OK. Answer the most recent reply directly: clarify, agree, push back with specifics, or ask for information. If the conversation is resolved on their side, acknowledge and stop."
}

RULES:
- Be kind. The author is a capable teammate. Explain, don't scold.
- Don't repeat yourself or restate the original comment — the human already read it.
- If you're wrong or they've convinced you, say so explicitly.
- Do not invent additional line comments, verdicts, or file changes; the only output is the reply body.
- Do not reply with "Thanks!" or other content-free acknowledgements when there's nothing substantive to add.

Respond now with the JSON object only.`;
}

export function buildReviewPrompt(args: {
  pr: PrContext;
  repo: string;
  pullNumber: number;
  tone: string;
  tickets?: TicketContext[];
  /** When triage ran, the files we chose NOT to review in depth. Surfaced to Claude so the summary can mention what's been deferred. */
  deferredFiles?: string[];
}): string {
  const fileBlocks = args.pr.files
    .map((f) => {
      if (!f.patch) return `--- ${f.path} (${f.status}, no patch) ---`;
      return `--- ${f.path} (${f.status}) ---\n${f.patch}`;
    })
    .join("\n\n");

  const intentBlock = renderIntent(args.tickets);

  return `You are reviewing pull request ${args.repo}#${args.pullNumber}.

TITLE: ${args.pr.title}

DESCRIPTION:
${args.pr.body || "(no description)"}

BASE: ${args.pr.base_ref}   HEAD: ${args.pr.head_ref}
${intentBlock}${renderDeferred(args.deferredFiles)}
REVIEW TONE:
${args.tone}

TASK:
Read the diff below and produce a code review. Your output MUST be a single JSON
object on stdout and NOTHING else — no prose before or after, no markdown fences.

JSON schema:
{
  "summary": "2-5 sentences. Start with the overall verdict and the 'why' in one sentence, then outline the most important findings or, if approving, the strongest evidence this is correct.",
  "line_comments": [
    {
      "path": "path/relative/to/repo/root",
      "line": 42,
      "side": "RIGHT",
      "body": "Specific, actionable. Explain WHY it matters and HOW to fix — include a concrete replacement or approach. If it is a style nit, say so.",
      "severity": "nit" | "suggestion" | "issue" | "blocker"
    }
  ],
  "verdict": "approve" | "request_changes"
}

RULES:
- 'line' must be a line number that actually appears in the diff below. If you
  cannot attach an observation to a specific diff line, fold it into 'summary'
  instead of inventing a line number.
- 'side' is RIGHT for added/context lines (the new file) and LEFT for deleted
  lines (the old file). Default to RIGHT if unsure.
- Any comment with severity 'blocker' or 'issue' REQUIRES verdict "request_changes".
  Only 'nit' or 'suggestion' comments are compatible with "approve".
- No trivial nits. Only call out nits if they compound, mislead a reader, or
  reveal a pattern.
- Be kind. The author is a capable teammate. Explain, don't scold.${args.tickets && args.tickets.length > 0 ? "\n- Use the TICKET CONTEXT to judge whether the code actually achieves what the\n  linked issue(s) asked for. A code-looks-clean-but-doesn't-solve-the-issue PR\n  deserves a 'request_changes' with a clear explanation." : ""}

DIFF:
${fileBlocks}

Respond now with the JSON object only.`;
}

/**
 * Triage prompt: a lightweight first pass that classifies every changed
 * file by review priority. No diff bodies — just file stats — so the prompt
 * stays small even on huge PRs. Claude picks which files deserve full
 * review; the loop then builds a normal review prompt with only those.
 */
export function buildTriagePrompt(args: {
  pr: PrContext;
  repo: string;
  pullNumber: number;
  tickets?: TicketContext[];
}): string {
  const fileLines = args.pr.files
    .map((f) => {
      const adds = f.rightLines.size;
      const dels = f.leftLines.size;
      return `- ${f.path}  (${f.status}, +${adds} / -${dels})`;
    })
    .join("\n");

  const intentBlock = renderIntent(args.tickets);

  return `You are triaging pull request ${args.repo}#${args.pullNumber} to decide which files warrant deep review attention. This PR has too many files to review every one in depth; pick where a careful review pays off most.

TITLE: ${args.pr.title}

DESCRIPTION:
${args.pr.body || "(no description)"}
${intentBlock}
FILES CHANGED (${args.pr.files.length}):
${fileLines}

TASK:
Output ONLY a single JSON object, no prose:

{
  "priorities": [
    {"path": "exact path from the list above", "priority": "high" | "medium" | "low", "reason": "one short sentence"}
  ]
}

RULES:
- Classify EVERY file. If uncertain, pick "medium".
- "high": security-sensitive code, auth, crypto, data integrity, public API
  surface, complex state machines, core business logic. Also files referenced
  in the PR title or ticket context.
- "low": test fixtures, doc-only changes, formatting, simple import sorting,
  obvious generated code, version bumps.
- "medium": everything else.
- One reason per file, short.

Respond now with the JSON object only.`;
}

/**
 * Trim a PrContext to just the subset of files identified as high priority.
 * Called by the loop after a successful triage. Keeps PrContext's metadata
 * (title, body, head_sha, etc) unchanged; only the files[] array shrinks.
 */
export function narrowToFiles(pr: PrContext, paths: Set<string>): PrContext {
  const files: FileDiff[] = pr.files.filter((f) => paths.has(f.path));
  return { ...pr, files };
}

function renderDeferred(deferred: string[] | undefined): string {
  if (!deferred || deferred.length === 0) return "";
  const shown = deferred.slice(0, 30);
  const more = deferred.length > shown.length ? `\n  (… and ${deferred.length - shown.length} more)` : "";
  return `
DEFERRED FILES (not reviewed in depth — too many files in this PR to deep-review each one):
  ${shown.join("\n  ")}${more}

Mention this in your summary so the PR author knows which files you did and didn't inspect.
`;
}

function renderIntent(tickets: TicketContext[] | undefined): string {
  if (!tickets || tickets.length === 0) return "";
  const blocks = tickets.map((t) => {
    const body = t.body.length > MAX_TICKET_BODY_CHARS
      ? t.body.slice(0, MAX_TICKET_BODY_CHARS) + "\n… (truncated)"
      : t.body;
    return `[${t.key}${t.isPullRequest ? " — is a pull request" : ""}] ${t.title}
${t.url}
${body || "(no description)"}`;
  });
  return `
TICKET CONTEXT (for awareness — the code still has to do what the ticket asks):

${blocks.join("\n\n---\n\n")}
`;
}
