import { describe, expect, test } from "bun:test";
import type { PullRequestFile } from "../src/github";
import { applicableHeuristics } from "../src/review/heuristics/index";
import { HEURISTICS as TS_HEURISTICS } from "../src/review/heuristics/typescript";
import { HEURISTICS as PY_HEURISTICS } from "../src/review/heuristics/python";
import { HEURISTICS as GO_HEURISTICS } from "../src/review/heuristics/go";
import { HEURISTICS as JAVA_HEURISTICS } from "../src/review/heuristics/java";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(filename: string): PullRequestFile {
  return {
    filename,
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1 +1 @@\n-old\n+new\n",
  };
}

// ---------------------------------------------------------------------------
// Heuristic pack counts — each language must ship ≥ 5 heuristics
// ---------------------------------------------------------------------------

describe("Heuristic pack sizes", () => {
  test("TypeScript pack has at least 5 heuristics", () => {
    expect(TS_HEURISTICS.length).toBeGreaterThanOrEqual(5);
  });

  test("Python pack has at least 5 heuristics", () => {
    expect(PY_HEURISTICS.length).toBeGreaterThanOrEqual(5);
  });

  test("Go pack has at least 5 heuristics", () => {
    expect(GO_HEURISTICS.length).toBeGreaterThanOrEqual(5);
  });

  test("Java pack has at least 5 heuristics", () => {
    expect(JAVA_HEURISTICS.length).toBeGreaterThanOrEqual(5);
  });

  test("all heuristic IDs are unique within a pack", () => {
    for (const pack of [TS_HEURISTICS, PY_HEURISTICS, GO_HEURISTICS, JAVA_HEURISTICS]) {
      const ids = pack.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

// ---------------------------------------------------------------------------
// Single-language PRs
// ---------------------------------------------------------------------------

describe("applicableHeuristics — TypeScript", () => {
  test(".ts file → TypeScript pack returned", () => {
    const result = applicableHeuristics([makeFile("src/widget.ts")]);
    expect(result).toEqual(TS_HEURISTICS);
  });

  test(".tsx extension → TypeScript pack returned", () => {
    const result = applicableHeuristics([makeFile("src/App.tsx")]);
    expect(result).toEqual(TS_HEURISTICS);
  });

  test(".js extension → TypeScript pack returned", () => {
    const result = applicableHeuristics([makeFile("lib/utils.js")]);
    expect(result).toEqual(TS_HEURISTICS);
  });

  test(".mjs extension → TypeScript pack returned", () => {
    const result = applicableHeuristics([makeFile("esm/mod.mjs")]);
    expect(result).toEqual(TS_HEURISTICS);
  });

  test("all 5 TypeScript heuristic IDs are present", () => {
    const result = applicableHeuristics([makeFile("src/api.ts")]);
    const ids = result.map((h) => h.id);
    expect(ids).toContain("ts/unhandled-promise");
    expect(ids).toContain("ts/any-in-exports");
    expect(ids).toContain("ts/non-null-assertion-external");
    expect(ids).toContain("ts/unsafe-as-cast");
    expect(ids).toContain("ts/mutated-default-param");
  });
});

describe("applicableHeuristics — Python", () => {
  test(".py file → Python pack returned", () => {
    const result = applicableHeuristics([makeFile("service/handler.py")]);
    expect(result).toEqual(PY_HEURISTICS);
  });

  test(".pyi stub file → Python pack returned", () => {
    // .pyi files are Python type stubs and belong to the Python ecosystem.
    const result = applicableHeuristics([makeFile("stubs/types.pyi")]);
    expect(result).toEqual(PY_HEURISTICS);
  });

  test("all 5 Python heuristic IDs are present", () => {
    const result = applicableHeuristics([makeFile("app/models.py")]);
    const ids = result.map((h) => h.id);
    expect(ids).toContain("py/mutable-default-arg");
    expect(ids).toContain("py/bare-except");
    expect(ids).toContain("py/string-concat-logging");
    expect(ids).toContain("py/resource-leak");
    expect(ids).toContain("py/missing-init");
  });
});

describe("applicableHeuristics — Go", () => {
  test(".go file → Go pack returned", () => {
    const result = applicableHeuristics([makeFile("internal/server/handler.go")]);
    expect(result).toEqual(GO_HEURISTICS);
  });

  test("all 5 Go heuristic IDs are present", () => {
    const result = applicableHeuristics([makeFile("cmd/main.go")]);
    const ids = result.map((h) => h.id);
    expect(ids).toContain("go/error-check-shadow");
    expect(ids).toContain("go/defer-in-loop");
    expect(ids).toContain("go/unchecked-goroutine");
    expect(ids).toContain("go/slice-header-share");
    expect(ids).toContain("go/context-not-threaded");
  });
});

describe("applicableHeuristics — Java", () => {
  test(".java file → Java pack returned", () => {
    const result = applicableHeuristics([makeFile("src/main/java/Service.java")]);
    expect(result).toEqual(JAVA_HEURISTICS);
  });

  test("all 5 Java heuristic IDs are present", () => {
    const result = applicableHeuristics([makeFile("com/example/Widget.java")]);
    const ids = result.map((h) => h.id);
    expect(ids).toContain("java/raw-types");
    expect(ids).toContain("java/static-mutable-state");
    expect(ids).toContain("java/boxed-equals");
    expect(ids).toContain("java/resource-not-autoclosed");
    expect(ids).toContain("java/instanceof-without-pattern");
  });
});

// ---------------------------------------------------------------------------
// Mixed-language PRs
// ---------------------------------------------------------------------------

describe("applicableHeuristics — mixed language PRs", () => {
  test("one .ts and one .py file → both packs concatenated in stable order", () => {
    const result = applicableHeuristics([
      makeFile("src/handler.ts"),
      makeFile("scripts/deploy.py"),
    ]);
    // TypeScript pack comes first (ts before py in stable order)
    expect(result.slice(0, TS_HEURISTICS.length)).toEqual(TS_HEURISTICS);
    expect(result.slice(TS_HEURISTICS.length)).toEqual(PY_HEURISTICS);
    expect(result.length).toBe(TS_HEURISTICS.length + PY_HEURISTICS.length);
  });

  test("multiple .ts files produce the TypeScript pack only once", () => {
    const result = applicableHeuristics([
      makeFile("src/a.ts"),
      makeFile("src/b.ts"),
      makeFile("src/c.tsx"),
    ]);
    expect(result).toEqual(TS_HEURISTICS);
    expect(result.length).toBe(TS_HEURISTICS.length);
  });

  test("all four languages present → all four packs concatenated in stable order", () => {
    const result = applicableHeuristics([
      makeFile("src/a.ts"),
      makeFile("lib/b.py"),
      makeFile("cmd/c.go"),
      makeFile("src/D.java"),
    ]);
    const expected = [
      ...TS_HEURISTICS,
      ...PY_HEURISTICS,
      ...GO_HEURISTICS,
      ...JAVA_HEURISTICS,
    ];
    expect(result).toEqual(expected);
  });

  test("file order in diff does not affect output order (stable by language key)", () => {
    const forward = applicableHeuristics([
      makeFile("a.py"),
      makeFile("b.ts"),
    ]);
    const reversed = applicableHeuristics([
      makeFile("b.ts"),
      makeFile("a.py"),
    ]);
    // Both orderings produce ts-then-py because packs are emitted in a fixed order
    expect(forward).toEqual(reversed);
    // TypeScript is first in both
    expect(forward[0]!.id).toContain("ts/");
  });
});

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe("applicableHeuristics — no-op on unsupported files", () => {
  test("empty file list → empty result", () => {
    expect(applicableHeuristics([])).toEqual([]);
  });

  test("only Markdown and JSON files → empty result", () => {
    const result = applicableHeuristics([
      makeFile("README.md"),
      makeFile("package.json"),
    ]);
    expect(result).toEqual([]);
  });

  test("only lockfiles → empty result", () => {
    const result = applicableHeuristics([
      makeFile("package-lock.json"),
      makeFile("yarn.lock"),
    ]);
    expect(result).toEqual([]);
  });

  test("only CSS and HTML files → empty result", () => {
    const result = applicableHeuristics([
      makeFile("styles/app.css"),
      makeFile("public/index.html"),
    ]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Extension edge cases
// ---------------------------------------------------------------------------

describe("applicableHeuristics — extension edge cases", () => {
  test(".tsx → TypeScript (not its own pack)", () => {
    const result = applicableHeuristics([makeFile("components/Button.tsx")]);
    expect(result).toEqual(TS_HEURISTICS);
  });

  test(".pyi → Python pack", () => {
    const result = applicableHeuristics([makeFile("stubs/client.pyi")]);
    expect(result).toEqual(PY_HEURISTICS);
  });

  test(".go file in non-vendor path → Go pack", () => {
    const result = applicableHeuristics([makeFile("internal/db/store.go")]);
    expect(result).toEqual(GO_HEURISTICS);
  });

  test(".mod file (go.mod) → no pack (not a .go source file)", () => {
    // go.mod and go.sum are not .go files; no heuristics apply.
    const result = applicableHeuristics([makeFile("go.mod")]);
    expect(result).toEqual([]);
  });

  test("go.sum → no pack", () => {
    const result = applicableHeuristics([makeFile("go.sum")]);
    expect(result).toEqual([]);
  });
});
