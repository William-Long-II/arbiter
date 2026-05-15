// Pure heuristics derived from a PR's changed-file paths — no I/O, so they
// unit-test without mocking GitHub or the runner. Two signals feed a
// review:
//   * sensitive-path scrutiny escalation (#3)
//   * test-gap note (#9)
// Both are advisory and conservative: false positives only add a sentence
// to the prompt or one tier of rigor — never drop or block a review.

import type { Scrutiny } from '../db/scopes.ts';

/**
 * Changed file paths from a unified diff. Reads `diff --git a/… b/…`
 * headers (covers add / modify / delete / rename) and falls back to the
 * `+++ b/…` line. Also understands arbiter's reconstructed large-PR
 * manifest lines ("  path/to/file  (+x/-y, status)" and the
 * "# Files changed but not shown above" block). Deduped, first-seen order.
 */
export function changedFilePaths(diff: string): string[] {
  const out = new Set<string>();
  const lines = diff.split('\n');
  for (const line of lines) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (gitHeader) {
      out.add(gitHeader[2]!.trim());
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus && plus[1] !== '/dev/null') {
      out.add(plus[1]!.trim());
      continue;
    }
    // Reconstructed-diff manifest row: two leading spaces, path, then a
    // "  (+N/-N, status)" suffix.
    const manifest = /^ {2}(\S.*?)\s{2}\(\+\d+\/-\d+, [a-z]+\)\s*$/.exec(line);
    if (manifest) out.add(manifest[1]!.trim());
  }
  return [...out];
}

// Paths where a mistake is unusually expensive: identity/authz, secret
// material, crypto, schema migrations, CI/CD, and container/infra. Matched
// case-insensitively against the full path.
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(Dockerfile|docker-compose\.ya?ml|\.dockerignore)$/i,
  /(^|\/)(Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml)$/i,
  /(^|\/)\.circleci\//i,
  /(^|\/)migrations?\//i,
  /(^|\/)(auth|authn|authz|login|session|oauth|saml|sso|jwt|password|secret|secrets|credential|credentials|crypto|encrypt|encryption|kms|signing|token)[^/]*\.[a-z]+$/i,
  /\.(tf|tfvars)$/i,
  /(^|\/)(k8s|kubernetes|helm|terraform)\//i,
];

/** Sensitive paths among `paths` (deduped, capped at 8 for messaging). */
export function sensitivePathHits(paths: string[]): string[] {
  const hits = paths.filter((p) => SENSITIVE_PATTERNS.some((re) => re.test(p)));
  return hits.slice(0, 8);
}

const SCRUTINY_RANK: Record<Scrutiny, number> = {
  light: 0,
  standard: 1,
  strict: 2,
};

/**
 * If the PR touches sensitive paths and the scope's tier is below
 * `strict`, escalate this run to `strict`. Returns null when no change is
 * warranted (already strict, or nothing sensitive).
 */
export function escalateScrutiny(
  current: Scrutiny,
  paths: string[],
): { scrutiny: Scrutiny; hits: string[] } | null {
  if (SCRUTINY_RANK[current] >= SCRUTINY_RANK.strict) return null;
  const hits = sensitivePathHits(paths);
  if (hits.length === 0) return null;
  return { scrutiny: 'strict', hits };
}

// Source files (a non-exhaustive but broad cross-language set). Test files
// are detected first and excluded so a PR that only changes tests doesn't
// count as "code changed".
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs)\//i;
const TEST_FILE =
  /(\.|_|-)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|[A-Za-z0-9]Test\.(java|kt|scala)$|_spec\.rb$/i;
const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|kts|scala|php|cs|swift|c|cc|cpp|cxx|h|hpp|m|mm|ex|exs|clj|dart)$/i;

function isTestPath(p: string): boolean {
  return TEST_PATH.test(p) || TEST_FILE.test(p);
}

/**
 * Note when a PR changes source code but touches no test files at all —
 * not a blocker, just a focal point for the reviewer. Returns null when
 * code didn't change, or when at least one test file did.
 */
export function testGapNote(paths: string[]): string | null {
  const tests = paths.filter(isTestPath);
  if (tests.length > 0) return null;
  const code = paths.filter((p) => CODE_FILE.test(p) && !isTestPath(p));
  if (code.length === 0) return null;
  return (
    `This PR changes ${code.length} source file(s) and **no test files**. ` +
    `Call out untested behavioral changes; don't demand tests for trivial / ` +
    `non-behavioral edits.`
  );
}

/**
 * Compose the optional reviewer callout from both signals (or null if
 * neither fired). The worker passes the result as ReviewInput.signalsNote.
 */
export function buildSignalsNote(
  escalation: { scrutiny: Scrutiny; hits: string[] } | null,
  testGap: string | null,
): string | null {
  const parts: string[] = [];
  if (escalation) {
    const shown = escalation.hits.slice(0, 5).join(', ');
    const more = escalation.hits.length > 5 ? ', …' : '';
    parts.push(
      `Scrutiny auto-escalated to **strict** — this PR touches ` +
        `sensitive paths (${shown}${more}). Review these with extra care.`,
    );
  }
  if (testGap) parts.push(testGap);
  return parts.length > 0 ? parts.join(' ') : null;
}
