import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

const RepoEntrySchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).default("auto-on-sync"),
  rereview_label: z.string().default("re-review"),
});

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

const ReposFileSchema = z.object({
  repos: z.record(z.string(), RepoEntrySchema),
});

export type RepoAllowlist = {
  isAllowed: (fullName: string) => boolean;
  get: (fullName: string) => RepoEntry | undefined;
  all: () => Record<string, RepoEntry>;
};

export function buildAllowlist(
  repos: Record<string, RepoEntry>,
): RepoAllowlist {
  const normalized: Record<string, RepoEntry> = {};
  for (const [key, value] of Object.entries(repos)) {
    normalized[key.toLowerCase()] = value;
  }
  return {
    isAllowed: (fullName) => {
      const entry = normalized[fullName.toLowerCase()];
      return Boolean(entry?.enabled);
    },
    get: (fullName) => normalized[fullName.toLowerCase()],
    all: () => ({ ...normalized }),
  };
}

// ---------------------------------------------------------------------------
// Mutable holder — swapped atomically (single JS assignment) on reload.
// ---------------------------------------------------------------------------

/** The current live allowlist snapshot. Replaced on every successful reload. */
let _holder: RepoAllowlist | null = null;

/** Path that was used at boot; stored so reload() can re-read the same file. */
let _reposPath: string | null = null;

/**
 * Returns the current allowlist snapshot.
 *
 * Must be called after loadAllowlist() has seeded the holder.
 */
export function getAllowlist(): RepoAllowlist {
  if (_holder === null) {
    throw new Error("getAllowlist() called before loadAllowlist() seeded the holder");
  }
  // Snapshot the reference once so every caller in the same event-loop turn
  // sees the same object, even if a concurrent reload swaps _holder.
  return _holder;
}

/**
 * Re-reads the repos file from disk and atomically swaps the holder.
 *
 * On any IO or parse error the old snapshot is preserved and the error is
 * returned as a structured value — the holder is never replaced with a
 * broken one.
 */
export function reload(): { ok: true; count: number } | { ok: false; error: string } {
  if (_reposPath === null) {
    return { ok: false, error: "reload() called before loadAllowlist() set the path" };
  }

  let raw: string;
  try {
    raw = readFileSync(_reposPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let data: z.infer<typeof ReposFileSchema>;
  try {
    data = ReposFileSchema.parse(parsed ?? { repos: {} });
  } catch (err) {
    return {
      ok: false,
      error: `Schema validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Build the new snapshot before swapping — if buildAllowlist threw we'd
  // want to keep the old one, but it is pure/synchronous so won't throw in
  // practice.
  const next = buildAllowlist(data.repos);

  // Atomic swap: a single assignment is atomic in single-threaded JS.
  _holder = next;

  return { ok: true, count: Object.keys(data.repos).length };
}

/**
 * Parses `path` and seeds the mutable holder. Call once at boot.
 *
 * Subsequent changes to the file on disk take effect via `reload()`.
 */
export function loadReposFile(path: string): RepoAllowlist {
  _reposPath = path;
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw);
  const data = ReposFileSchema.parse(parsed ?? { repos: {} });
  const allowlist = buildAllowlist(data.repos);
  _holder = allowlist;
  return allowlist;
}
