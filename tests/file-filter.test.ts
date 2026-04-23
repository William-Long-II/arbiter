import { describe, expect, test } from "bun:test";
import { DEFAULT_EXCLUDE_PATHS, filterFiles } from "../src/review/file-filter.ts";
import type { FileDiff } from "../src/github/diff.ts";

function file(path: string): FileDiff {
  return {
    path,
    patch: "",
    rightLines: new Set<number>(),
    leftLines: new Set<number>(),
    status: "modified",
  };
}

describe("filterFiles", () => {
  test("empty include + empty exclude = pass everything through", () => {
    const input = [file("a.ts"), file("b.md"), file("c/d.py")];
    const { kept, skipped } = filterFiles(input, [], []);
    expect(kept).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  test("default excludes drop lockfiles and node_modules", () => {
    const input = [
      file("src/main.ts"),
      file("package-lock.json"),
      file("frontend/yarn.lock"),
      file("node_modules/lodash/index.js"),
      file("src/nested/node_modules/thing/x.js"),
      file("README.md"),
    ];
    const { kept, skipped } = filterFiles(input, [], DEFAULT_EXCLUDE_PATHS);
    expect(kept.map((f) => f.path)).toEqual(["src/main.ts", "README.md"]);
    expect(skipped.map((s) => s.file.path).sort()).toEqual([
      "frontend/yarn.lock",
      "node_modules/lodash/index.js",
      "package-lock.json",
      "src/nested/node_modules/thing/x.js",
    ]);
  });

  test("include list acts as a whitelist", () => {
    const input = [file("src/a.ts"), file("tests/b.ts"), file("docs/c.md")];
    const { kept } = filterFiles(input, ["src/**"], []);
    expect(kept.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  test("include + exclude intersect (include first, then exclude)", () => {
    const input = [
      file("src/main.ts"),
      file("src/main.test.ts"),
      file("src/generated.ts"),
    ];
    const { kept } = filterFiles(input, ["src/**"], ["**/*.test.ts", "**/generated.ts"]);
    expect(kept.map((f) => f.path)).toEqual(["src/main.ts"]);
  });

  test("skipped reason distinguishes not_included from excluded", () => {
    const input = [
      file("src/a.ts"), // included, not excluded → kept
      file("tests/b.ts"), // not in include → not_included
      file("src/generated.ts"), // in include, in exclude → excluded
    ];
    const { skipped } = filterFiles(input, ["src/**"], ["**/generated.ts"]);
    expect(skipped).toHaveLength(2);
    const byPath = Object.fromEntries(
      skipped.map((s) => [s.file.path, { reason: s.reason, pattern: s.pattern }]),
    );
    expect(byPath["tests/b.ts"]!.reason).toBe("not_included");
    expect(byPath["src/generated.ts"]!.reason).toBe("excluded");
    expect(byPath["src/generated.ts"]!.pattern).toBe("**/generated.ts");
  });

  test("generated code default catches common patterns", () => {
    const input = [
      file("src/types.generated.ts"),
      file("packages/api/__generated__/schema.ts"),
      file("dist/index.js"),
      file("src/main.ts"),
    ];
    const { kept, skipped } = filterFiles(input, [], DEFAULT_EXCLUDE_PATHS);
    expect(kept.map((f) => f.path)).toEqual(["src/main.ts"]);
    expect(skipped.map((s) => s.file.path).sort()).toEqual([
      "dist/index.js",
      "packages/api/__generated__/schema.ts",
      "src/types.generated.ts",
    ]);
  });

  test("* does not cross path segments; ** does", () => {
    const input = [
      file("a.lock"),
      file("nested/a.lock"),
      file("x/y/z/a.lock"),
    ];
    // star-only pattern matches only the root case
    const single = filterFiles(input, [], ["*.lock"]);
    expect(single.kept.map((f) => f.path).sort()).toEqual([
      "nested/a.lock",
      "x/y/z/a.lock",
    ]);
    // double-star pattern catches everything
    const deep = filterFiles(input, [], ["**/*.lock"]);
    expect(deep.kept).toHaveLength(0);
  });

  test("case-sensitive matching", () => {
    const input = [file("Package-Lock.json"), file("package-lock.json")];
    const { kept } = filterFiles(input, [], ["**/package-lock.json"]);
    expect(kept.map((f) => f.path)).toEqual(["Package-Lock.json"]);
  });
});
