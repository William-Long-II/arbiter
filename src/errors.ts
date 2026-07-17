/**
 * Reduce an unknown thrown value to a non-empty, human-useful string.
 *
 * Why this exists: the worker persists this into `pending_reviews.error`
 * so a failed review is debuggable. The old inline
 * `err instanceof Error ? err.message : String(err)` looked sufficient
 * but produced an EMPTY string for a real failure (row 3333,
 * bodhi-web-apps#3428): something was thrown whose `.message` was blank.
 * A blank `error` makes a failure impossible to diagnose after the fact.
 * This guarantees we always store *something* actionable.
 */
// An upstream (GitHub) error surfaced as a whole HTML document — e.g. the
// 5xx "Unicorn!" page — instead of a JSON error. Storing it verbatim puts
// ~300 KB of markup and base64 images into pending_reviews.error and the
// logs. Collapse it to one line that keeps the diagnostic value: status
// (when the error carries one) and the page <title>.
// Anchored to the start: the message must BE an HTML document (that's how
// Octokit surfaces an HTML body), not merely mention a tag.
const HTML_DOC_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

function collapseHtmlErrorPage(msg: string, err: Error): string | null {
  if (!HTML_DOC_RE.test(msg)) return null;
  const status = (err as { status?: unknown }).status;
  const title = msg
    .match(/<title>\s*([^<]{0,200}?)\s*<\/title>/i)?.[1]
    ?.replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&');
  const parts = [
    typeof status === 'number' ? `HTTP ${status}` : null,
    title ? `"${title}"` : null,
  ].filter(Boolean);
  return `upstream returned an HTML error page${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    let msg = err.message?.trim();
    if (msg) {
      msg = collapseHtmlErrorPage(msg, err) ?? msg;
      // Prefix the class name for typed errors so e.g. a bare
      // "Unprocessable Entity" still tells you it was an HttpError.
      return err.name && err.name !== 'Error' ? `${err.name}: ${msg}` : msg;
    }
    // No message — fall back to name + first stack frame so the failure
    // is at least locatable instead of blank.
    const frame = err.stack?.split('\n')[1]?.trim();
    const name = err.name || 'Error';
    return frame ? `${name} (no message) @ ${frame}` : `${name} (no message)`;
  }
  if (err === null) return 'Non-error thrown: null';
  if (err === undefined) return 'Non-error thrown: undefined';
  if (typeof err === 'string') {
    const s = err.trim();
    return s || 'Non-error thrown: empty string';
  }
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}') return `Non-error thrown: ${json}`;
  } catch {
    /* circular / non-serialisable — fall through to String() */
  }
  const s = String(err).trim();
  return s || 'Unknown error (uninformative throw; see worker logs)';
}
