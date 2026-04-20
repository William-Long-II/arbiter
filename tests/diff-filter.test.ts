import { describe, expect, test } from "bun:test";
import type { PullRequestFile } from "../src/github";
import type { OmittedFile } from "../src/review/diff-filter";
import {
  filterDiff,
  globToRegex,
  parseLinguistPatterns,
  OMITTED_FILES_SENTINEL,
} from "../src/review/diff-filter";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<PullRequestFile> & { filename: string }): PullRequestFile {
  return {
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    ...overrides,
  };
}

// ─── globToRegex ─────────────────────────────────────────────────────────────

describe("globToRegex", () => {
  test("exact match", () => {
    const re = globToRegex("README.md");
    expect(re.test("README.md")).toBe(true);
    expect(re.test("docs/README.md")).toBe(false);
  });

  test("* does not cross slashes", () => {
    const re = globToRegex("src/*.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/nested/foo.ts")).toBe(false);
  });

  test("** crosses slashes", () => {
    const re = globToRegex("src/**");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/nested/foo.ts")).toBe(true);
    expect(re.test("lib/foo.ts")).toBe(false);
  });

  test("? matches one non-slash character", () => {
    const re = globToRegex("src/fo?.ts");
    expect(re.test("src/foo.ts")).toBe(true);
    expect(re.test("src/fo.ts")).toBe(false);
    expect(re.test("src/fo/o.ts")).toBe(false);
  });

  test("dots are treated as literals", () => {
    const re = globToRegex("package.json");
    expect(re.test("package.json")).toBe(true);
    expect(re.test("packageXjson")).toBe(false);
  });
});

// ─── parseLinguistPatterns ────────────────────────────────────────────────────

describe("parseLinguistPatterns", () => {
  test("extracts linguist-generated patterns", () => {
    const content = `
# comment
src/generated/*.ts linguist-generated=true
vendor/**           linguist-vendored=true
docs/api.md         merge=union
`;
    const regexes = parseLinguistPatterns(content);
    expect(regexes).toHaveLength(2);
    expect(regexes[0]!.test("src/generated/foo.ts")).toBe(true);
    expect(regexes[1]!.test("vendor/some/lib.js")).toBe(true);
  });

  test("returns empty array for empty input", () => {
    expect(parseLinguistPatterns("")).toHaveLength(0);
  });

  test("ignores comment-only lines", () => {
    const content = "# this is a comment\n   # another\n";
    expect(parseLinguistPatterns(content)).toHaveLength(0);
  });
});

// ─── filterDiff — lockfile filter ────────────────────────────────────────────

describe("filterDiff — lockfile", () => {
  test.each([
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
  ])("omits %s as lockfile", (name) => {
    const files = [makeFile({ filename: name })];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.reason).toBe("lockfile");
  });

  test("omits nested lockfiles by basename", () => {
    const files = [makeFile({ filename: "frontend/package-lock.json" })];
    const { omitted } = filterDiff(files);
    expect(omitted[0]!.reason).toBe("lockfile");
  });

  test("keeps non-lockfile json files", () => {
    const files = [makeFile({ filename: "config/settings.json" })];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(0);
  });
});

// ─── filterDiff — extension filter ───────────────────────────────────────────

describe("filterDiff — extension", () => {
  test.each([
    ["dist/app.min.js", "extension" as OmittedFile["reason"]],
    ["style.min.css", "extension" as OmittedFile["reason"]],
    ["app.js.map", "extension" as OmittedFile["reason"]],
    ["logo.png", "extension" as OmittedFile["reason"]],
    ["photo.jpg", "extension" as OmittedFile["reason"]],
    ["anim.gif", "extension" as OmittedFile["reason"]],
    ["image.webp", "extension" as OmittedFile["reason"]],
    ["favicon.ico", "extension" as OmittedFile["reason"]],
    ["font.woff", "extension" as OmittedFile["reason"]],
    ["font.woff2", "extension" as OmittedFile["reason"]],
    ["font.ttf", "extension" as OmittedFile["reason"]],
    ["font.otf", "extension" as OmittedFile["reason"]],
    ["legacy.eot", "extension" as OmittedFile["reason"]],
    ["archive.zip", "extension" as OmittedFile["reason"]],
    ["release.tar", "extension" as OmittedFile["reason"]],
    ["bundle.gz", "extension" as OmittedFile["reason"]],
    ["report.pdf", "extension" as OmittedFile["reason"]],
  ])("omits %s as %s", (filename, reason) => {
    const files = [makeFile({ filename })];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.reason).toBe(reason);
  });

  test(".min.js takes priority over plain .js", () => {
    const files = [makeFile({ filename: "dist/bundle.min.js" })];
    const { omitted } = filterDiff(files);
    expect(omitted[0]!.reason).toBe("extension");
  });

  test("keeps regular .js files", () => {
    const files = [makeFile({ filename: "src/app.js" })];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(0);
  });
});

// ─── filterDiff — binary marker ───────────────────────────────────────────────

describe("filterDiff — binary patch marker", () => {
  test("omits file with 'Binary files' in patch", () => {
    const files = [
      makeFile({
        filename: "data.bin",
        patch: "Binary files a/data.bin and b/data.bin differ",
      }),
    ];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.reason).toBe("binary");
  });

  test("keeps file without binary marker", () => {
    const files = [makeFile({ filename: "data.bin", patch: "@@ -1 +1 @@\n-x\n+y\n" })];
    const { omitted } = filterDiff(files);
    expect(omitted).toHaveLength(0);
  });
});

// ─── filterDiff — linguist-generated ─────────────────────────────────────────

describe("filterDiff — linguist-generated", () => {
  const gitattributes = "src/generated/*.ts linguist-generated=true\nvendor/** linguist-vendored=true\n";

  test("omits linguist-generated file", () => {
    const files = [makeFile({ filename: "src/generated/proto.ts" })];
    const { omitted } = filterDiff(files, { gitattributes });
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.reason).toBe("linguist-generated");
  });

  test("omits linguist-vendored file", () => {
    const files = [makeFile({ filename: "vendor/jquery/dist/jquery.js" })];
    const { omitted } = filterDiff(files, { gitattributes });
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.reason).toBe("linguist-generated");
  });

  test("keeps unrelated file", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    const { omitted } = filterDiff(files, { gitattributes });
    expect(omitted).toHaveLength(0);
  });
});

// ─── filterDiff — glob overrides ─────────────────────────────────────────────

describe("filterDiff — include_paths glob", () => {
  const files = [
    makeFile({ filename: "src/app.ts" }),
    makeFile({ filename: "docs/guide.md" }),
    makeFile({ filename: "scripts/build.sh" }),
  ];

  test("include_paths keeps only matching files", () => {
    const { omitted, filtered } = filterDiff(files, { include: ["src/**"] });
    expect(omitted).toHaveLength(2);
    expect(omitted.map((o) => o.path)).toContain("docs/guide.md");
    expect(omitted.map((o) => o.path)).toContain("scripts/build.sh");
    expect(omitted[0]!.reason).toBe("include-glob");
    // src/app.ts should appear in the diff section (after OMITTED block)
    expect(filtered).toContain("src/app.ts");
    // docs/guide.md should appear only in the OMITTED block, not in the diff section
    const diffSectionStart = filtered.indexOf("\n### ");
    expect(diffSectionStart).toBeGreaterThan(0);
    const diffSection = filtered.slice(diffSectionStart);
    expect(diffSection).not.toContain("docs/guide.md");
    expect(diffSection).not.toContain("scripts/build.sh");
  });

  test("empty include array keeps all files (no constraint)", () => {
    const { omitted } = filterDiff(files, { include: [] });
    expect(omitted).toHaveLength(0);
  });
});

describe("filterDiff — exclude_paths glob", () => {
  const files = [
    makeFile({ filename: "src/app.ts" }),
    makeFile({ filename: "docs/guide.md" }),
    makeFile({ filename: "docs/api.md" }),
  ];

  test("exclude_paths drops matching files", () => {
    const { omitted } = filterDiff(files, { exclude: ["docs/**"] });
    expect(omitted).toHaveLength(2);
    expect(omitted.every((o) => o.reason === "exclude-glob")).toBe(true);
  });

  test("empty exclude array keeps all files", () => {
    const { omitted } = filterDiff(files, { exclude: [] });
    expect(omitted).toHaveLength(0);
  });
});

// ─── filterDiff — OMITTED_FILES sentinel ─────────────────────────────────────

describe("filterDiff — OMITTED_FILES sentinel", () => {
  test("sentinel is present when files are omitted", () => {
    const files = [
      makeFile({ filename: "package-lock.json" }),
      makeFile({ filename: "src/app.ts" }),
    ];
    const { filtered } = filterDiff(files);
    expect(filtered).toContain(OMITTED_FILES_SENTINEL);
    expect(filtered).toContain("- package-lock.json (lockfile)");
  });

  test("sentinel is absent when nothing is omitted", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    const { filtered } = filterDiff(files);
    expect(filtered).not.toContain(OMITTED_FILES_SENTINEL);
  });

  test("kept file content appears after omitted block", () => {
    const files = [
      makeFile({ filename: "yarn.lock" }),
      makeFile({ filename: "src/index.ts", patch: "@@ -1 +1 @@\n+hello\n" }),
    ];
    const { filtered } = filterDiff(files);
    const sentinelPos = filtered.indexOf(OMITTED_FILES_SENTINEL);
    const filePos = filtered.indexOf("src/index.ts");
    expect(sentinelPos).toBeGreaterThanOrEqual(0);
    expect(filePos).toBeGreaterThan(sentinelPos);
  });
});

// ─── filterDiff — error resilience ───────────────────────────────────────────

describe("filterDiff — error resilience", () => {
  test("does not throw on empty file list", () => {
    expect(() => filterDiff([])).not.toThrow();
    expect(filterDiff([]).omitted).toHaveLength(0);
  });

  test("does not throw on empty include/exclude", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    expect(() => filterDiff(files, { include: [], exclude: [] })).not.toThrow();
  });

  test("does not throw on malformed gitattributes", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    expect(() =>
      filterDiff(files, { gitattributes: "   \n\n\t\n" }),
    ).not.toThrow();
  });
});

// ─── Integration: 2 MB lockfile ──────────────────────────────────────────────

describe("filterDiff — integration: large lockfile", () => {
  test("filtered output is well below 2 MB lockfile size", () => {
    const bigPatch = "+" + "x".repeat(2 * 1024 * 1024); // ~2 MB
    const files = [
      makeFile({ filename: "package-lock.json", patch: bigPatch }),
      makeFile({ filename: "src/index.ts", patch: "@@ -1 +1 @@\n+hello\n" }),
    ];

    const { filtered, omitted } = filterDiff(files);

    // lockfile must be in omitted list
    expect(omitted).toHaveLength(1);
    expect(omitted[0]!.path).toBe("package-lock.json");
    expect(omitted[0]!.reason).toBe("lockfile");

    // filtered text should be far smaller than the raw lockfile patch
    expect(filtered.length).toBeLessThan(bigPatch.length / 10);
  });
});
