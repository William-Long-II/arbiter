import type { PullRequestFile } from "../github";

// ─── Built-in omit rules ────────────────────────────────────────────────────

/** Exact filenames that are always treated as lockfiles. */
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "go.sum",
  "composer.lock",
]);

/** Extensions whose files are always omitted (minified, maps, binary assets). */
const OMIT_EXTENSIONS = new Set([
  ".min.js",
  ".min.css",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".tar",
  ".gz",
  ".pdf",
]);

/**
 * Sentinel string prepended to the filtered diff when at least one file was
 * omitted. The prompt builder can detect this with a simple `includes` check.
 */
export const OMITTED_FILES_SENTINEL = "OMITTED_FILES:";

// ─── Glob helper ────────────────────────────────────────────────────────────

/**
 * Converts a simple glob pattern to a RegExp.
 *
 * Supported syntax:
 *   `**`  → matches any number of path segments (including zero)
 *   `*`   → matches any characters except `/`
 *   `?`   → matches a single character except `/`
 *
 * No new dependencies — intentionally minimal. Known limitation: this does
 * not fully replicate bash/minimatch semantics for edge cases (e.g., a bare
 * double-star vs double-star-slash prefix distinction), but it is sufficient
 * for path-prefix patterns like "src/**" and "docs/**".
 */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // `**` — match anything, including slashes
      re += ".*";
      i += 2;
      // consume a trailing slash after `**` so `src/**` matches `src/foo`
      if (pattern[i] === "/") i++;
    } else if (pattern[i] === "*") {
      re += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      re += "[^/]";
      i++;
    } else {
      // escape regex metacharacters
      re += pattern[i]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

// ─── .gitattributes parsing ──────────────────────────────────────────────────

/**
 * Parses a `.gitattributes` file string and returns the set of path patterns
 * flagged with `linguist-generated=true` or `linguist-vendored=true`.
 *
 * Each line is: <pattern> [attr …]
 * We check each attr token for the two linguist markers.
 */
export function parseLinguistPatterns(gitattributes: string): RegExp[] {
  const regexes: RegExp[] = [];
  for (const raw of gitattributes.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const [patternPart, ...attrs] = line.split(/\s+/);
    if (!patternPart) continue;

    const isGenerated = attrs.some(
      (a) =>
        a === "linguist-generated=true" || a === "linguist-vendored=true",
    );
    if (isGenerated) {
      regexes.push(globToRegex(patternPart));
    }
  }
  return regexes;
}

// ─── Public types ────────────────────────────────────────────────────────────

export type OmittedFile = {
  path: string;
  reason: "lockfile" | "extension" | "binary" | "linguist-generated" | "linguist-vendored" | "include-glob" | "exclude-glob";
};

export type FilterDiffOptions = {
  /** Only include files matching at least one of these glob patterns. */
  include?: string[];
  /** Exclude files matching any of these glob patterns (applied after include). */
  exclude?: string[];
  /**
   * Raw content of the repo's `.gitattributes` file. When provided, files
   * with `linguist-generated=true` or `linguist-vendored=true` are omitted.
   */
  gitattributes?: string;
};

export type FilterDiffResult = {
  /**
   * Filtered diff text: the kept file hunks joined together, with an
   * `OMITTED_FILES:` summary block prepended when any file was dropped.
   */
  filtered: string;
  /** Every file that was dropped and why. */
  omitted: OmittedFile[];
};

// ─── Core filter logic ───────────────────────────────────────────────────────

/**
 * Classifies a single `PullRequestFile` against the built-in and configured
 * omit rules. Returns the omit reason or `null` if the file should be kept.
 */
function classifyFile(
  file: PullRequestFile,
  includeRegexes: RegExp[],
  excludeRegexes: RegExp[],
  linguistRegexes: RegExp[],
): OmittedFile["reason"] | null {
  const { filename, patch } = file;

  // 1. include-glob override: if any patterns are given, the file must match
  if (includeRegexes.length > 0) {
    const kept = includeRegexes.some((r) => r.test(filename));
    if (!kept) return "include-glob";
  }

  // 2. exclude-glob override
  if (excludeRegexes.some((r) => r.test(filename))) {
    return "exclude-glob";
  }

  // 3. Lockfile by exact basename
  const basename = filename.split("/").pop() ?? filename;
  if (LOCKFILE_NAMES.has(basename)) return "lockfile";

  // 4. Extension-based omit — check longest suffix first so `.min.js` beats `.js`
  const sortedExts = [...OMIT_EXTENSIONS].sort((a, b) => b.length - a.length);
  for (const ext of sortedExts) {
    if (filename.endsWith(ext)) return "extension";
  }

  // 5. GitHub "Binary files differ" marker in the patch
  if (patch && patch.includes("Binary files")) return "binary";

  // 6. .gitattributes linguist markers
  for (const re of linguistRegexes) {
    if (re.test(filename)) return "linguist-generated";
  }

  return null;
}

/**
 * Builds a text representation of a single kept file, matching the format
 * used by `buildUserMessage` in `prompt.ts` — so the filtered output can be
 * dropped in at the diff-handoff point without reformatting.
 *
 * This is intentionally kept simple (no markdown headers); callers that need
 * richer formatting can post-process.  The primary consumer is the prompt
 * builder which re-renders from `PullRequestFile` objects anyway.
 */
function fileToText(file: PullRequestFile): string {
  const PATCH_PLACEHOLDER =
    "// patch omitted (binary, renamed without changes, or too large)";
  return `### ${file.filename} (${file.status}, +${file.additions} / -${file.deletions})\n\`\`\`diff\n${file.patch ?? PATCH_PLACEHOLDER}\n\`\`\``;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Filters a `PullRequestDiff`'s file list, removing lockfiles, binary assets,
 * minified/generated files, and any per-repo glob overrides.
 *
 * The function never throws: malformed globs produce a no-op regex, empty
 * include/exclude arrays are treated as "no constraint", and missing
 * `.gitattributes` content is silently skipped.
 *
 * @param files       The file list from `PullRequestDiff.files`.
 * @param opts        Optional configuration overrides.
 * @returns           `{ filtered, omitted }` — filtered is the kept hunks as
 *                    text (with OMITTED_FILES block prepended if any were
 *                    dropped); omitted is the list of dropped files.
 */
export function filterDiff(
  files: PullRequestFile[],
  opts: FilterDiffOptions = {},
): FilterDiffResult {
  // Compile glob patterns — invalid globs produce a regex that never matches,
  // which is safe: the file is kept rather than incorrectly dropped.
  const includeRegexes = (opts.include ?? []).map((p) => {
    try {
      return globToRegex(p);
    } catch {
      return /(?!)/; // never matches — keep the file
    }
  });

  const excludeRegexes = (opts.exclude ?? []).map((p) => {
    try {
      return globToRegex(p);
    } catch {
      return /(?!)/; // never matches — don't drop the file
    }
  });

  const linguistRegexes: RegExp[] = opts.gitattributes
    ? parseLinguistPatterns(opts.gitattributes)
    : [];

  const kept: PullRequestFile[] = [];
  const omitted: OmittedFile[] = [];

  for (const file of files) {
    const reason = classifyFile(
      file,
      includeRegexes,
      excludeRegexes,
      linguistRegexes,
    );
    if (reason !== null) {
      omitted.push({ path: file.filename, reason });
    } else {
      kept.push(file);
    }
  }

  // Build output text
  const parts: string[] = [];

  if (omitted.length > 0) {
    parts.push(OMITTED_FILES_SENTINEL);
    for (const o of omitted) {
      parts.push(`- ${o.path} (${o.reason})`);
    }
    parts.push(""); // blank line separator
  }

  for (const file of kept) {
    parts.push(fileToText(file));
  }

  return { filtered: parts.join("\n"), omitted };
}
