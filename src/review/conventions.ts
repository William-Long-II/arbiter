import type { Octokit } from "../github/client";
import { log } from "../server/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConventionSection = {
  path: string;
  content: string;
  truncated: boolean;
};

export type ConventionsResult = {
  sections: Array<ConventionSection>;
  totalBytes: number;
};

export type FetchConventionsInput = {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files to attempt to fetch, in priority order. */
const CONVENTION_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

const PER_FILE_CAP = 16 * 1024; // 16 KB
const TOTAL_CAP = 48 * 1024; // 48 KB
const TRUNCATION_MARKER = "\n\n[...truncated]\n";

// ---------------------------------------------------------------------------
// LRU cache (dependency-free, Map + access-order re-insertion)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX = 100;

type CacheEntry = {
  value: ConventionsResult;
  expiresAt: number;
};

class LruCache {
  // Map preserves insertion order; we re-insert on access to move to end.
  private map = new Map<string, CacheEntry>();

  get(key: string): ConventionsResult | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used) by re-inserting.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: ConventionsResult): void {
    // Evict LRU entry when at capacity.
    if (this.map.size >= CACHE_MAX && !this.map.has(key)) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.delete(key); // ensure re-insertion at end
    this.map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /** Visible for testing: total live (non-expired) entries. */
  size(): number {
    return this.map.size;
  }

  /** Visible for testing: delete a specific key. */
  delete(key: string): void {
    this.map.delete(key);
  }
}

// Module-level singleton; shared within one process/worker.
export const conventionsCache = new LruCache();

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch a single file from the target repo.
 * Returns null on 404 (expected for repos that don't have the file).
 * Returns null and emits a warn log for other errors, so the review never fails.
 */
async function fetchFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });

    // getContent can return an array (directory listing) — skip those.
    if (Array.isArray(data) || data.type !== "file") {
      return null;
    }

    // Content is base64-encoded when returned as a file.
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      return null;
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err: unknown) {
    const status =
      err != null && typeof err === "object" && "status" in err
        ? (err as { status: unknown }).status
        : undefined;

    if (status === 404) {
      // Expected — repo simply does not have this file.
      log.debug("conventions file not found", { owner, repo, path, ref });
      return null;
    }

    // Unexpected error (5xx, network failure, etc.) — warn but don't fail.
    log.warn("conventions.fetch_failed", { owner, repo, ref, error: String(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch repo-level contributor convention files and return their contents,
 * subject to per-file and total size caps. Results are cached per
 * (owner/repo@ref) with a 10-minute TTL.
 *
 * Never throws — on any failure the returned sections list will simply be
 * smaller or empty, so the review pipeline continues unaffected.
 */
export async function fetchConventions(
  input: FetchConventionsInput,
): Promise<ConventionsResult> {
  const { octokit, owner, repo, ref } = input;
  const cacheKey = `${owner}/${repo}@${ref}`;

  const cached = conventionsCache.get(cacheKey);
  if (cached) return cached;

  const sections: ConventionSection[] = [];
  let totalBytes = 0;

  for (const path of CONVENTION_FILES) {
    if (totalBytes >= TOTAL_CAP) break;

    const raw = await fetchFile(octokit, owner, repo, path, ref);
    if (raw === null) continue;

    const remaining = TOTAL_CAP - totalBytes;
    let content = raw;
    let truncated = false;

    // Apply per-file cap first.
    if (content.length > PER_FILE_CAP) {
      content = content.slice(0, PER_FILE_CAP) + TRUNCATION_MARKER;
      truncated = true;
    }

    // Apply total-budget cap.
    if (content.length > remaining) {
      content = content.slice(0, remaining) + TRUNCATION_MARKER;
      truncated = true;
    }

    totalBytes += content.length;
    sections.push({ path, content, truncated });
  }

  const result: ConventionsResult = { sections, totalBytes };
  conventionsCache.set(cacheKey, result);
  return result;
}
