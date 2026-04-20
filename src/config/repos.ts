import { readFileSync } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

const ReviewConfigSchema = z.object({
  include_paths: z.array(z.string()).optional(),
  exclude_paths: z.array(z.string()).optional(),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/**
 * Full per-repo entry as it appears in the `repos:` block of repos.yaml.
 * All fields have built-in defaults so the only truly required field is the
 * key itself (the repo full name).
 */
const RepoEntrySchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).default("auto-on-sync"),
  rereview_label: z.string().default("re-review"),
  review: ReviewConfigSchema.optional(),
});

export type RepoEntry = z.infer<typeof RepoEntrySchema>;

/**
 * Org-level defaults. Every field is fully optional — an org entry may supply
 * any subset. An org entry with `enabled: true` (or the default `true`) makes
 * repos under that org allowed even without an explicit `repos:` entry.
 */
const OrgDefaultsSchema = z.object({
  enabled: z.boolean().default(true),
  rereview: z.enum(["auto-on-sync", "label-or-mention"]).optional(),
  rereview_label: z.string().optional(),
  review: ReviewConfigSchema.optional(),
});

export type OrgDefaults = z.infer<typeof OrgDefaultsSchema>;

const ReposFileSchema = z.object({
  orgs: z.record(z.string(), OrgDefaultsSchema).optional(),
  repos: z.record(z.string(), RepoEntrySchema).optional().default({}),
});

// ---------------------------------------------------------------------------
// Built-in defaults (layer 3 — the bottom of the resolution stack)
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULTS = {
  enabled: true,
  rereview: "auto-on-sync" as const,
  rereview_label: "re-review",
  review: undefined as ReviewConfig | undefined,
};

// ---------------------------------------------------------------------------
// ResolvedRepoConfig — the fully-materialized per-repo settings
// ---------------------------------------------------------------------------

/**
 * The result of merging explicit repo entry → org defaults → built-in defaults.
 * Every field is always present. Callers that need merged settings (rereview
 * mode, rereview_label, review filter) should use `getEffectiveConfig` rather
 * than the raw `get` accessor.
 */
export type ResolvedRepoConfig = {
  enabled: boolean;
  rereview: "auto-on-sync" | "label-or-mention";
  rereview_label: string;
  review?: ReviewConfig;
};

// ---------------------------------------------------------------------------
// Allowlist holder
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

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

export function loadReposFile(path: string): RepoAllowlist {
  const raw = readFileSync(path, "utf8");
  const parsed = YAML.parse(raw);
  const data = ReposFileSchema.parse(parsed ?? { repos: {} });
  return buildAllowlist(data.repos ?? {}, data.orgs ?? {});
}

// ---------------------------------------------------------------------------
// Mutable holder — used by the server for hot-reload via SIGHUP
// ---------------------------------------------------------------------------

/**
 * A reloadable wrapper around `RepoAllowlist`. The holder delegates all reads
 * to its internal snapshot; `reload()` atomically swaps the snapshot by
 * re-reading `path` from disk.
 *
 * Why a holder rather than re-exporting a plain reference: the server wires up
 * `allowlist` once at startup and passes it into `createWebhooks`. If we just
 * re-assigned a module-level variable the webhook handlers would still hold a
 * stale closure. The holder lets every call-site close over the holder object
 * and always read through the current snapshot.
 */
export type RepoAllowlistHolder = RepoAllowlist & {
  /** Re-reads `path` and atomically swaps the internal snapshot. */
  reload: () => void;
};

export function createAllowlistHolder(path: string): RepoAllowlistHolder {
  let current = loadReposFile(path);

  return {
    isAllowed: (fullName) => current.isAllowed(fullName),
    get: (fullName) => current.get(fullName),
    all: () => current.all(),
    getEffectiveConfig: (fullName) => current.getEffectiveConfig(fullName),
    reload: () => {
      // Throws on parse error — callers should catch and keep old snapshot.
      current = loadReposFile(path);
    },
  };
}

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

    // Split into owner / name. An input without exactly one slash is
    // malformed — return null defensively rather than throwing.
    const slashIdx = key.indexOf("/");
    if (slashIdx <= 0 || slashIdx === key.length - 1) return null;
    const owner = key.slice(0, slashIdx);

    const repoEntry = normalizedRepos[key];
    const orgEntry = normalizedOrgs[owner];

    // A repo is allowed when it has an explicit entry OR when there is an org
    // entry with enabled true (or defaulted true).
    const hasExplicitRepo = repoEntry !== undefined;
    const orgEnabled = orgEntry?.enabled ?? false;

    if (!hasExplicitRepo && !orgEnabled) return null;

    // Merge: explicit repo > org defaults > built-in defaults.
    const enabled = repoEntry?.enabled ?? orgEntry?.enabled ?? BUILTIN_DEFAULTS.enabled;
    const rereview = repoEntry?.rereview ?? orgEntry?.rereview ?? BUILTIN_DEFAULTS.rereview;
    const rereview_label = repoEntry?.rereview_label ?? orgEntry?.rereview_label ?? BUILTIN_DEFAULTS.rereview_label;

    // For review config, merge at the object level (either layer wins entirely;
    // no deep-field merging between repo and org layers to keep it predictable).
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
