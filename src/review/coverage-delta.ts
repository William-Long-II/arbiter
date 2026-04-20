/**
 * Test-coverage delta heuristic.
 *
 * This module classifies files in a PR diff as source, test, or other
 * and computes a lightweight signal for the review prompt. The intent is
 * to give the LLM a concrete, deterministic view of "added 120 src lines,
 * 0 test lines" so it can comment on coverage gaps without having to infer
 * that from raw patch text.
 *
 * Why regex and not AST: AST parsers are language-specific heavy dependencies.
 * Regex over added lines catches the vast majority of top-level declarations
 * and is fast enough to run inline in the review pipeline. The limitations
 * (misses destructuring exports, dynamic assignment) are documented in the
 * prompt injection itself so the LLM knows the list is advisory, not exhaustive.
 */

import type { PullRequestFile } from "../github";
import { langFromPath } from "./languages";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Coarse category for a file in the diff. */
export type FileCategory =
  | "source"
  | "test"
  | "config"
  | "docs"
  | "generated"
  | "other";

export type FlaggedSymbol = {
  file: string;
  symbol: string;
};

export type CoverageDelta = {
  /** Net added lines across all source files (after filtering). */
  addedSrcLines: number;
  /** Net added lines across all test files. */
  addedTestLines: number;
  /**
   * addedTestLines / addedSrcLines, or 0 when addedSrcLines === 0.
   * Values > 1 are possible (more test lines added than src lines).
   */
  ratio: number;
  /** Top-level declarations in added source lines that have no accompanying
   * test-file additions. Advisory only — regex extraction misses dynamic
   * exports and some advanced patterns. */
  flaggedSymbols: FlaggedSymbol[];
};

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

/**
 * Path-fragment patterns that, when found in the file path, indicate a test
 * file regardless of extension.
 *
 * Note: `__tests__` (with double underscores) is the Jest/TypeScript
 * convention and is intentionally supported here. Plain `test` and `tests`
 * segments cover Python, Go, and many other ecosystems.
 */
const TEST_PATH_SEGMENTS = [
  /(?:^|\/)tests?\//,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)spec\//,
  /(?:^|\/)specs\//,
];

/**
 * Filename-suffix patterns that identify test files by name alone.
 * Checked after path-segment rules so a file like `src/test/helper.ts`
 * is still classified as test before we reach this list.
 */
const TEST_FILENAME_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /_test\.go$/,
  /_test\.py$/,
  /^test_.*\.py$/,         // Python: test_foo.py (basename match below)
];

const DOC_EXTENSIONS = new Set([".md", ".rst", ".txt", ".adoc", ".mdx"]);

const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env",
  ".xml",
  ".gradle",
]);

const CONFIG_BASENAMES = new Set([
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".gitignore",
  ".gitattributes",
  ".eslintrc",
  ".prettierrc",
  "tsconfig.json",
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "build.gradle",
  "pom.xml",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
]);

const GENERATED_PATH_SEGMENTS = [
  /(?:^|\/)generated\//,
  /(?:^|\/)gen\//,
  /(?:^|\/)\.gen\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)out\//,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)vendor\//,
  /\.pb\.go$/,     // protobuf-generated Go
  /\.pb\.ts$/,     // protobuf-generated TypeScript
];

/**
 * Classify a file path into a coarse category.
 *
 * Rules are applied in this priority order so more specific rules win:
 *   1. Generated (vendored, dist, protobuf)
 *   2. Test (path segment or filename suffix)
 *   3. Source (known source extension)
 *   4. Docs
 *   5. Config
 *   6. Other
 */
export function classifyFile(path: string): FileCategory {
  const basename = path.split("/").pop() ?? path;
  const dotIdx = basename.lastIndexOf(".");
  const ext = dotIdx >= 0 ? basename.slice(dotIdx) : "";

  // 1. Generated/vendored
  for (const re of GENERATED_PATH_SEGMENTS) {
    if (re.test(path)) return "generated";
  }

  // 2. Test — path segment first, then filename suffix
  for (const re of TEST_PATH_SEGMENTS) {
    if (re.test(path)) return "test";
  }
  for (const re of TEST_FILENAME_PATTERNS) {
    // For `test_*.py` pattern we need to match only the basename
    if (re.source.startsWith("^test_")) {
      if (re.test(basename)) return "test";
    } else {
      if (re.test(path)) return "test";
    }
  }

  // 3. Config basename check before source extension so that known config
  //    filenames (setup.py, Makefile, etc.) are not misclassified as source.
  if (CONFIG_BASENAMES.has(basename)) return "config";

  // 4. Source
  if (SOURCE_EXTENSIONS.has(ext)) return "source";

  // 5. Docs
  if (DOC_EXTENSIONS.has(ext)) return "docs";

  // 6. Config by extension
  if (CONFIG_EXTENSIONS.has(ext)) return "config";

  return "other";
}

// ---------------------------------------------------------------------------
// Symbol extraction from patch added lines
// ---------------------------------------------------------------------------

/**
 * Per-language regex patterns for top-level symbol declarations.
 *
 * Each pattern must have exactly one capture group that yields the symbol name.
 *
 * Why regex instead of an AST parser: an AST parser would require one
 * dependency per language. Regexes over added lines in a git patch catch the
 * common cases (named functions, classes, methods) without any dependency.
 * Limitations: anonymous functions, destructured exports, and re-exports are
 * not caught — the prompt notes this is advisory.
 */
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  ts: [
    // export function foo, export async function foo
    /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/,
    // export const foo = (...) => or export const foo = function
    /^export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\(|function)/,
    // export class Foo
    /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // export default function foo — named only
    /^export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    // public/private/protected/static method declarations in a class body
    /^(?:(?:public|private|protected|static|async|override)\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
  ],
  py: [
    // def foo( — skip private (__) and ignore leading spaces (methods in class)
    /^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // async def foo(
    /^async\s+def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // class Foo:
    /^class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/,
  ],
  go: [
    // func FuncName( — plain function
    /^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    // func (r ReceiverType) MethodName( — method with receiver
    /^func\s+\([^)]+\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
  ],
  java: [
    // public/protected/private [static] [final] ReturnType methodName(
    /^(?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)+[A-Za-z_$][A-Za-z0-9_$<>\[\]]*\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/,
    // class Foo or interface Foo
    /^(?:public\s+|protected\s+|private\s+)?(?:abstract\s+|final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  ],
};

// langFromPath is imported from ./languages — shared with heuristics/index.ts.

/**
 * Extract symbols from the added lines of a patch hunk.
 *
 * Added lines start with `+` (but not `+++` which is the diff header).
 * We strip the leading `+` and trim indentation before matching so that
 * method declarations inside class bodies are also caught.
 *
 * Decorator lines (`@Something`) are skipped — they precede the symbol
 * but are not the symbol themselves.
 */
export function extractSymbolsFromPatch(path: string, patch: string): string[] {
  const lang = langFromPath(path);
  if (!lang) return [];
  const patterns = SYMBOL_PATTERNS[lang];
  if (!patterns) return [];

  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of patch.split("\n")) {
    // Only process added lines, not context lines (space) or removed lines (-)
    if (!rawLine.startsWith("+") || rawLine.startsWith("+++")) continue;

    // Strip the leading `+` and trim leading whitespace to handle indented methods
    const line = rawLine.slice(1).trimStart();

    // Skip decorator lines — they are annotations, not symbol definitions
    if (line.startsWith("@")) continue;
    // Skip comments
    if (line.startsWith("//") || line.startsWith("#") || line.startsWith("*")) continue;

    for (const pattern of patterns) {
      const m = pattern.exec(line);
      if (m && m[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        symbols.push(m[1]);
        break; // one symbol per line
      }
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute the test-coverage delta for a filtered file list.
 *
 * Call with post-filter files only so flagged symbols correspond to files
 * that will actually appear in the review prompt.
 *
 * Returns `{ addedSrcLines: 0, addedTestLines: 0, ratio: 0, flaggedSymbols: [] }`
 * for empty input or all-non-source files — callers should skip injection when
 * `addedSrcLines === 0`.
 */
export function computeCoverageDelta(files: PullRequestFile[]): CoverageDelta {
  let addedSrcLines = 0;
  let addedTestLines = 0;
  const flaggedSymbols: FlaggedSymbol[] = [];
  const testFilesAdded = new Set<string>();

  // First pass: collect categories and test filenames
  const categorised: Array<{ file: PullRequestFile; category: FileCategory }> =
    [];
  for (const file of files) {
    const category = classifyFile(file.filename);
    categorised.push({ file, category });
    if (category === "test") {
      testFilesAdded.add(file.filename);
    }
  }

  // Second pass: accumulate line counts and extract symbols
  for (const { file, category } of categorised) {
    if (category === "source") {
      addedSrcLines += file.additions;
      // Extract symbols from added lines in source files that have no
      // corresponding test file in this diff.
      // We use a simple heuristic: if no test file was added at all in this
      // diff, every source symbol is flagged. If test files were added, we
      // still flag symbols (we don't attempt cross-file symbol matching —
      // that would require an AST and cross-file analysis).
      const symbols = extractSymbolsFromPatch(
        file.filename,
        file.patch ?? "",
      );
      for (const symbol of symbols) {
        flaggedSymbols.push({ file: file.filename, symbol });
      }
    } else if (category === "test") {
      addedTestLines += file.additions;
    }
  }

  // Only flag symbols when there are no test additions at all. If any test
  // lines were added, the developer made some effort; don't enumerate every
  // symbol as untested since we can't do cross-file resolution at this layer.
  const effectiveFlaggedSymbols =
    addedTestLines === 0 ? flaggedSymbols : [];

  const ratio =
    addedSrcLines > 0 ? addedTestLines / addedSrcLines : 0;

  return {
    addedSrcLines,
    addedTestLines,
    ratio,
    flaggedSymbols: effectiveFlaggedSymbols,
  };
}
