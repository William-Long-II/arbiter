// Pure: map model-reported findings to GitHub review-comment anchors.
//
// GitHub's pulls.createReview rejects the ENTIRE submission (422) if any
// comment points at a line that isn't part of the diff. So we never trust
// the model's line numbers blind — we parse the unified diff, build the
// set of lines that are actually commentable on the RIGHT (new) side, and
// keep only the findings that land on one. Everything else stays in the
// summary body (the model wrote it there too). No I/O — unit-tested.

import type { FindingItem } from './format.ts';

export type ReviewComment = {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
};

// `@@ -oldStart[,oldLen] +newStart[,newLen] @@ [heading]`
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** GitHub caps comments per review; keep submissions sane regardless. */
export const MAX_INLINE_COMMENTS = 50;

function add(map: Map<string, Set<number>>, path: string, line: number): void {
  let set = map.get(path);
  if (!set) {
    set = new Set();
    map.set(path, set);
  }
  set.add(line);
}

/**
 * RIGHT-side line numbers that can carry an inline comment, per file path.
 * Added (`+`) and context (` `) lines qualify; removed (`-`) lines exist
 * only on the left and can't be anchored on RIGHT. Handles multi-file /
 * multi-hunk diffs and arbiter's reconstructed large-PR diff (same
 * `diff --git` / `+++ b/` / `@@` structure; manifest-only files simply
 * have no hunks, so nothing there is commentable).
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let path: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) {
      path = null;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      path = p === '/dev/null' ? null : p.replace(/^b\//, '');
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) {
      inHunk = false;
      continue;
    }
    const h = HUNK_RE.exec(raw);
    if (h) {
      newLine = parseInt(h[1]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || path === null) continue;

    const c = raw[0];
    if (c === '+') {
      add(map, path, newLine);
      newLine++;
    } else if (c === '-') {
      // left side only — does not advance the new-file counter
    } else if (c === ' ') {
      add(map, path, newLine);
      newLine++;
    } else if (c === '\\') {
      // "\ No newline at end of file" — not a real line
    } else {
      // Anything else (incl. a bare blank line) means the hunk ended.
      inHunk = false;
    }
  }
  return map;
}

/**
 * Keep only findings that anchor to a real diff line; the rest are
 * `dropped` (still present in the summary body the model wrote). Capped at
 * MAX_INLINE_COMMENTS; the overflow counts as dropped.
 */
export function selectReviewComments(
  items: FindingItem[],
  commentable: Map<string, Set<number>>,
): { comments: ReviewComment[]; dropped: number } {
  const comments: ReviewComment[] = [];
  let dropped = 0;
  for (const it of items) {
    const set = commentable.get(it.path);
    const bodyText = typeof it.body === 'string' ? it.body.trim() : '';
    if (set && Number.isInteger(it.line) && set.has(it.line) && bodyText) {
      comments.push({ path: it.path, line: it.line, side: 'RIGHT', body: bodyText });
    } else {
      dropped++;
    }
  }
  if (comments.length > MAX_INLINE_COMMENTS) {
    dropped += comments.length - MAX_INLINE_COMMENTS;
    comments.length = MAX_INLINE_COMMENTS;
  }
  return { comments, dropped };
}
