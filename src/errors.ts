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
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (msg) {
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
