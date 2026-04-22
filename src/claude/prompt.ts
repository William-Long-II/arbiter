import type { PrContext } from "../github/diff.ts";

export function buildReviewPrompt(args: {
  pr: PrContext;
  repo: string;
  pullNumber: number;
  tone: string;
}): string {
  const fileBlocks = args.pr.files
    .map((f) => {
      if (!f.patch) return `--- ${f.path} (${f.status}, no patch) ---`;
      return `--- ${f.path} (${f.status}) ---\n${f.patch}`;
    })
    .join("\n\n");

  return `You are reviewing pull request ${args.repo}#${args.pullNumber}.

TITLE: ${args.pr.title}

DESCRIPTION:
${args.pr.body || "(no description)"}

BASE: ${args.pr.base_ref}   HEAD: ${args.pr.head_ref}

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
- Be kind. The author is a capable teammate. Explain, don't scold.

DIFF:
${fileBlocks}

Respond now with the JSON object only.`;
}
