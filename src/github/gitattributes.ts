import type { Octokit } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FetchGitattributesInput = {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
};

// ─── LRU cache ────────────────────────────────────────────────────────────────

// Dependency-free Map-based LRU with a fixed capacity and per-entry TTL.
// WHY module-level: the cache is intentionally shared across calls within the
// same process so that multiple PRs on the same repo at the same ref benefit
// from one Octokit round-trip.

const CACHE_MAX = 100;
const CACHE_TTL_MS = 10 * 60 * 1_000; // 10 minutes

type CacheEntry = {
  value: string | null;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  // Move to end (most-recently-used) by re-inserting.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: string | null): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    // Evict the oldest (first) entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Exposed only for tests that need to verify TTL expiry with fake timers. */
export function _clearGitattributesCache(): void {
  cache.clear();
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetches the raw text of `.gitattributes` from the given repo at the given
 * ref. Returns `null` when the file doesn't exist (404) or when any error
 * occurs — the caller should treat `null` as "no gitattributes available"
 * and proceed without it.
 *
 * Successful (200) results are cached by `owner/repo@ref` for 10 minutes to
 * avoid redundant API calls across concurrent pipeline invocations for the
 * same PR head. 404 and transient-error results are not cached.
 */
export async function fetchGitattributes({
  octokit,
  owner,
  repo,
  ref,
}: FetchGitattributesInput): Promise<string | null> {
  const key = `${owner}/${repo}@${ref}`;

  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  let content: string;
  try {
    const res = await octokit.repos.getContent({ owner, repo, path: ".gitattributes", ref });

    // getContent can return a single file object or an array (directory listing).
    // An array means the path resolved to a directory — return null defensively.
    if (Array.isArray(res.data)) {
      return null;
    } else if (res.data.type !== "file") {
      // Symlinks and submodules have different shapes; treat them as absent.
      return null;
    } else {
      // The content field is base64-encoded in the file response.
      content = Buffer.from((res.data as { content: string }).content, "base64").toString("utf8");
    }
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) {
      // File absent — normal for repos without .gitattributes. Not cached:
      // the file may be added on a future push and 404 fetches are cheap.
      return null;
    }
    // Unexpected error — warn so operators can investigate, but don't block
    // the review pipeline. Emit a structured JSON line matching the project
    // log format; we avoid importing ../server/logger to keep the dependency
    // direction clean (server depends on github, not the reverse).
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        msg: "gitattributes fetch failed",
        evt: "gitattributes.fetch_failed",
        owner,
        repo,
        ref,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Do not cache transient failures — the next pipeline run should retry.
    return null;
  }

  cacheSet(key, content);
  return content;
}
