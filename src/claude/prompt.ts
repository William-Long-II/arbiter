import type { PrContext } from "../github/diff.ts";
import type { TicketContext } from "../intent/types.ts";

/**
 * Per-ticket body is capped so a novella on a linked issue can't crowd out
 * the diff. Reviewers should see enough intent to ground the review; they
 * don't need every paragraph.
 */
const MAX_TICKET_BODY_CHARS = 2000;

export function buildReviewPrompt(args: {
  pr: PrContext;
  repo: string;
  pullNumber: number;
  tone: string;
  tickets?: TicketContext[];
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
${intentBlock}
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
