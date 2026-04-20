import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const RepoReviewConfigSchema = z.object({
  include_paths: z.array(z.string()).optional(),
  exclude_paths: z.array(z.string()).optional(),
});

export type RepoReviewConfig = z.infer<typeof RepoReviewConfigSchema>;

/**
 * Full per-repo entry as it appears in the `repos:` block of repos.yaml.
 * All fields have built-in defaults so the only truly required field is the
 * key itself (the repo full name).
 */
const RepoEntrySchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).default("auto-on-sync"),
  rereview_label: z.string().default("re-review"),
  review: RepoReviewConfigSchema.optional(),
});

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

/**
 * Org-level defaults. Every field is fully optional — an org entry may supply
 * any subset. An org entry with `enabled: true` (default) makes repos under
 * that org allowed even without an explicit `repos:` entry.
 */
const OrgDefaultsSchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).optional(),
  rereview_label: z.string().optional(),
  review: RepoReviewConfigSchema.optional(),
});

export type OrgDefaults = z.infer<typeof OrgDefaultsSchema>;

const ReposFileSchema = z.object({
  orgs: z.record(z.string(), OrgDefaultsSchema).optional(),
  repos: z.record(z.string(), RepoEntrySchema).optional().default({}),
});

// ---------------------------------------------------------------------------
// Built-in defaults (layer 3 — bottom of the resolution stack)
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULTS = {
  enabled: true,
  rereview: "auto-on-sync" as const,
  rereview_label: "re-review",
  review: undefined as RepoReviewConfig | undefined,
};

// ---------------------------------------------------------------------------
// ResolvedRepoConfig — fully-materialized per-repo settings
// ---------------------------------------------------------------------------

/**
 * The result of merging explicit repo entry → org defaults → built-in defaults.
 * Callers that need merged settings (rereview mode, rereview_label, review
 * filter) use `getEffectiveConfig` rather than the raw `get` accessor.
 */
export type ResolvedRepoConfig = {
  enabled: boolean;
  rereview: "auto-on-sync" | "label-or-mention";
  rereview_label: string;
  review?: RepoReviewConfig;
};

// ---------------------------------------------------------------------------
// Allowlist snapshot
// ---------------------------------------------------------------------------

export type RepoAllowlist = {
  /** True when the repo resolves to a non-null, enabled config. */
  isAllowed: (fullName: string) => boolean;
  /**
   * Returns the raw explicit `repos:<name>` entry, if one exists.
   * Preserved for back-compat; callers that need merged settings should use
   * `getEffectiveConfig` instead.
   */
  get: (fullName: string) => RepoEntry | undefined;
  /** All explicit repo entries (raw, unmerged). */
  all: () => Record<string, RepoEntry>;
  /**
   * Returns the fully-merged config for `fullName`, applying the resolution
   * order: explicit repo entry → org defaults → built-in defaults.
   * Returns null when the repo is not allowed by any layer.
   */
  getEffectiveConfig: (fullName: string) => ResolvedRepoConfig | null;
};

export function buildAllowlist(
  repos: Record<string, RepoEntry>,
  orgs: Record<string, OrgDefaults> = {},
): RepoAllowlist {
  // Normalize keys to lowercase for case-insensitive matching.
  const normalizedRepos: Record<string, RepoEntry> = {};
  for (const [key, value] of Object.entries(repos)) {
    normalizedRepos[key.toLowerCase()] = value;
  }

  const normalizedOrgs: Record<string, OrgDefaults> = {};
  for (const [key, value] of Object.entries(orgs)) {
    normalizedOrgs[key.toLowerCase()] = value;
  }

  function getEffectiveConfig(fullName: string): ResolvedRepoConfig | null {
    const key = fullName.toLowerCase();

    // An input without exactly one slash is malformed — return null defensively.
    const slashIdx = key.indexOf("/");
    if (slashIdx <= 0 || slashIdx === key.length - 1) return null;
    const owner = key.slice(0, slashIdx);

    const repoEntry = normalizedRepos[key];
    const orgEntry = normalizedOrgs[owner];

    const hasExplicitRepo = repoEntry !== undefined;
    const orgEnabled = orgEntry?.enabled ?? false;

    if (!hasExplicitRepo && !orgEnabled) return null;

    const enabled = repoEntry?.enabled ?? orgEntry?.enabled ?? BUILTIN_DEFAULTS.enabled;
    const rereview = repoEntry?.rereview ?? orgEntry?.rereview ?? BUILTIN_DEFAULTS.rereview;
    const rereview_label = repoEntry?.rereview_label ?? orgEntry?.rereview_label ?? BUILTIN_DEFAULTS.rereview_label;

    // Review config merges at the object level — either layer wins entirely;
    // no deep-field merging to keep it predictable.
    const review = repoEntry?.review ?? orgEntry?.review ?? BUILTIN_DEFAULTS.review;

    return { enabled, rereview, rereview_label, review };
  }

  return {
    isAllowed: (fullName) => {
      const cfg = getEffectiveConfig(fullName);
      return cfg !== null && cfg.enabled;
    },
    get: (fullName) => normalizedRepos[fullName.toLowerCase()],
    all: () => ({ ...normalizedRepos }),
    getEffectiveConfig,
  };
}

// ---------------------------------------------------------------------------
// Mutable holder — module-level singleton swapped atomically on reload.
// ---------------------------------------------------------------------------

/** The current live allowlist snapshot. Replaced on every successful reload. */
let _holder: RepoAllowlist | null = null;

/** Path used at boot; stored so reload() can re-read the same file. */
let _reposPath: string | null = null;

/**
 * Returns the current allowlist snapshot.
 *
 * Must be called after loadReposFile() / loadAllowlist() has seeded the holder.
 */
export function getAllowlist(): RepoAllowlist {
  if (_holder === null) {
    throw new Error("getAllowlist() called before loadReposFile() seeded the holder");
  }
  // Snapshot the reference once so every caller in the same event-loop turn
  // sees the same object, even if a concurrent reload swaps _holder.
  return _holder;
}

/**
 * Re-reads the repos file from disk and atomically swaps the holder.
 *
 * On any IO or parse error the old snapshot is preserved and the error is
 * returned as a structured value — the holder is never replaced with a broken one.
 */
export function reload(): { ok: true; count: number } | { ok: false; error: string } {
  if (_reposPath === null) {
    return { ok: false, error: "reload() called before loadReposFile() set the path" };
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

  const next = buildAllowlist(data.repos, data.orgs ?? {});
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
  const allowlist = buildAllowlist(data.repos, data.orgs ?? {});
  _holder = allowlist;
  return allowlist;
}
