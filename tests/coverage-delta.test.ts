import { describe, expect, test } from "bun:test";
import {
  classifyFile,
  computeCoverageDelta,
  extractSymbolsFromPatch,
  type FileCategory,
} from "../src/review/coverage-delta";
import type { PullRequestFile } from "../src/github";

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

describe("classifyFile — TypeScript / JavaScript", () => {
  test("plain .ts source file is source", () => {
    expect(classifyFile("src/widgets/factory.ts")).toBe("source");
  });

  test(".tsx source file is source", () => {
    expect(classifyFile("src/components/Button.tsx")).toBe("source");
  });

  test(".js source file is source", () => {
    expect(classifyFile("lib/helpers.js")).toBe("source");
  });

  test(".test.ts file is test", () => {
    expect(classifyFile("src/widgets/factory.test.ts")).toBe("test");
  });

  test(".spec.ts file is test", () => {
    expect(classifyFile("src/widgets/factory.spec.ts")).toBe("test");
  });

  test(".test.js file is test", () => {
    expect(classifyFile("tests/helpers.test.js")).toBe("test");
  });

  test(".spec.js file is test", () => {
    expect(classifyFile("tests/helpers.spec.js")).toBe("test");
  });

  test("file inside tests/ directory is test", () => {
    expect(classifyFile("tests/unit/factory.ts")).toBe("test");
  });

  test("file inside test/ directory is test", () => {
    expect(classifyFile("src/test/factory.ts")).toBe("test");
  });

  test("file inside __tests__ directory is test", () => {
    expect(classifyFile("src/__tests__/factory.ts")).toBe("test");
  });

  test("file in dist/ is generated", () => {
    expect(classifyFile("dist/index.js")).toBe("generated");
  });

  test("file in node_modules/ is generated", () => {
    expect(classifyFile("node_modules/lodash/index.js")).toBe("generated");
  });
});

describe("classifyFile — Python", () => {
  test("plain .py file is source", () => {
    expect(classifyFile("myapp/service.py")).toBe("source");
  });

  test("_test.py suffix is test", () => {
    expect(classifyFile("myapp/service_test.py")).toBe("test");
  });

  test("test_*.py basename is test", () => {
    expect(classifyFile("tests/test_service.py")).toBe("test");
  });

  test("test_*.py at root is test", () => {
    expect(classifyFile("test_utils.py")).toBe("test");
  });

  test("file inside tests/ is test", () => {
    expect(classifyFile("tests/unit/service.py")).toBe("test");
  });

  test("setup.py is config", () => {
    expect(classifyFile("setup.py")).toBe("config");
  });
});

describe("classifyFile — Go", () => {
  test("plain .go file is source", () => {
    expect(classifyFile("pkg/api/handler.go")).toBe("source");
  });

  test("_test.go suffix is test", () => {
    expect(classifyFile("pkg/api/handler_test.go")).toBe("test");
  });

  test("file inside internal/ is source", () => {
    expect(classifyFile("internal/store/db.go")).toBe("source");
  });

  test("vendor/ directory is generated", () => {
    expect(classifyFile("vendor/github.com/foo/bar.go")).toBe("generated");
  });

  test(".pb.go is generated", () => {
    expect(classifyFile("proto/api.pb.go")).toBe("generated");
  });
});

describe("classifyFile — Java", () => {
  test("plain .java file is source", () => {
    expect(classifyFile("src/main/java/com/example/Widget.java")).toBe("source");
  });

  test("Test-suffixed .java file inside tests/ is test", () => {
    expect(classifyFile("src/test/java/com/example/WidgetTest.java")).toBe("test");
  });

  test("file inside src/test/ directory is test", () => {
    expect(classifyFile("src/test/java/Service.java")).toBe("test");
  });

  test("build/ directory is generated", () => {
    expect(classifyFile("build/classes/Widget.class")).toBe("generated");
  });

  test("pom.xml is config", () => {
    expect(classifyFile("pom.xml")).toBe("config");
  });
});

describe("classifyFile — docs and config", () => {
  test(".md file is docs", () => {
    expect(classifyFile("README.md")).toBe("docs");
  });

  test(".rst file is docs", () => {
    expect(classifyFile("docs/api.rst")).toBe("docs");
  });

  test("tsconfig.json is config", () => {
    expect(classifyFile("tsconfig.json")).toBe("config");
  });

  test(".yaml file is config", () => {
    expect(classifyFile("deploy/config.yaml")).toBe("config");
  });

  test("package.json is config", () => {
    expect(classifyFile("package.json")).toBe("config");
  });

  test("Makefile is config", () => {
    expect(classifyFile("Makefile")).toBe("config");
  });

  test("unknown extension is other", () => {
    expect(classifyFile("data/dump.bin")).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

describe("extractSymbolsFromPatch — TypeScript", () => {
  test("named export function", () => {
    const patch = `@@ -0,0 +1,3 @@\n+export function createWidget(id: string) {\n+  return { id };\n+}\n`;
    const syms = extractSymbolsFromPatch("src/factory.ts", patch);
    expect(syms).toContain("createWidget");
  });

  test("async export function", () => {
    const patch = `@@ -0,0 +1 @@\n+export async function fetchData(url: string) {\n`;
    expect(extractSymbolsFromPatch("src/api.ts", patch)).toContain("fetchData");
  });

  test("export class", () => {
    const patch = `@@ -0,0 +1 @@\n+export class WidgetFactory {\n`;
    expect(extractSymbolsFromPatch("src/factory.ts", patch)).toContain("WidgetFactory");
  });

  test("export abstract class", () => {
    const patch = `@@ -0,0 +1 @@\n+export abstract class BaseService {\n`;
    expect(extractSymbolsFromPatch("src/base.ts", patch)).toContain("BaseService");
  });

  test("export const arrow function", () => {
    const patch = `@@ -0,0 +1 @@\n+export const validate = (input: unknown) => {\n`;
    expect(extractSymbolsFromPatch("src/validate.ts", patch)).toContain("validate");
  });

  test("export const async arrow function", () => {
    const patch = `@@ -0,0 +1 @@\n+export const fetchUser = async (id: string) => {\n`;
    expect(extractSymbolsFromPatch("src/api.ts", patch)).toContain("fetchUser");
  });

  test("export const function expression", () => {
    const patch = `@@ -0,0 +1 @@\n+export const handler = function(req: Request) {\n`;
    expect(extractSymbolsFromPatch("src/handler.ts", patch)).toContain("handler");
  });

  test("anonymous export default function — not extracted (no name)", () => {
    const patch = `@@ -0,0 +1 @@\n+export default function() {\n`;
    expect(extractSymbolsFromPatch("src/anon.ts", patch)).toHaveLength(0);
  });

  test("named export default function — extracted", () => {
    const patch = `@@ -0,0 +1 @@\n+export default function myHandler() {\n`;
    expect(extractSymbolsFromPatch("src/handler.ts", patch)).toContain("myHandler");
  });

  test("class method — extracted", () => {
    const patch = `@@ -0,0 +1 @@\n+  public createWidget(name: string) {\n`;
    expect(extractSymbolsFromPatch("src/factory.ts", patch)).toContain("createWidget");
  });

  test("private method — extracted", () => {
    const patch = `@@ -0,0 +1 @@\n+  private validate(input: unknown) {\n`;
    expect(extractSymbolsFromPatch("src/service.ts", patch)).toContain("validate");
  });

  test("decorator line before function — decorator not extracted", () => {
    const patch = `@@ -0,0 +1,3 @@\n+@Injectable()\n+export class MyService {\n`;
    const syms = extractSymbolsFromPatch("src/service.ts", patch);
    expect(syms).not.toContain("Injectable");
    expect(syms).toContain("MyService");
  });

  test("comment lines not extracted", () => {
    const patch = `@@ -0,0 +1,3 @@\n+// export function notReal() {}\n+export function realFn() {}\n`;
    const syms = extractSymbolsFromPatch("src/util.ts", patch);
    expect(syms).not.toContain("notReal");
    expect(syms).toContain("realFn");
  });

  test("removed lines (starting with -) are ignored", () => {
    const patch = `@@ -1 +1 @@\n-export function oldFn() {}\n+export function newFn() {}\n`;
    const syms = extractSymbolsFromPatch("src/api.ts", patch);
    expect(syms).not.toContain("oldFn");
    expect(syms).toContain("newFn");
  });

  test("context lines (no prefix) are ignored", () => {
    const patch = `@@ -1,2 +1,2 @@\n export function contextFn() {}\n+export function addedFn() {}\n`;
    const syms = extractSymbolsFromPatch("src/api.ts", patch);
    expect(syms).not.toContain("contextFn");
    expect(syms).toContain("addedFn");
  });

  test("deduplicates symbols across hunks", () => {
    const patch = `@@ -0,0 +1 @@\n+export function dup() {}\n@@ -10,0 +11 @@\n+export function dup() {}\n`;
    const syms = extractSymbolsFromPatch("src/api.ts", patch);
    expect(syms.filter((s) => s === "dup")).toHaveLength(1);
  });
});

describe("extractSymbolsFromPatch — Python", () => {
  test("def function", () => {
    const patch = `@@ -0,0 +1 @@\n+def create_widget(name):\n`;
    expect(extractSymbolsFromPatch("service.py", patch)).toContain("create_widget");
  });

  test("async def function", () => {
    const patch = `@@ -0,0 +1 @@\n+async def fetch_data(url):\n`;
    expect(extractSymbolsFromPatch("service.py", patch)).toContain("fetch_data");
  });

  test("class definition", () => {
    const patch = `@@ -0,0 +1 @@\n+class WidgetFactory:\n`;
    expect(extractSymbolsFromPatch("factory.py", patch)).toContain("WidgetFactory");
  });

  test("class with base class", () => {
    const patch = `@@ -0,0 +1 @@\n+class Widget(BaseModel):\n`;
    expect(extractSymbolsFromPatch("models.py", patch)).toContain("Widget");
  });

  test("method inside class (indented def)", () => {
    const patch = `@@ -0,0 +1 @@\n+    def process(self, item):\n`;
    expect(extractSymbolsFromPatch("service.py", patch)).toContain("process");
  });

  test("decorator before def — decorator not extracted", () => {
    const patch = `@@ -0,0 +1,3 @@\n+@staticmethod\n+def helper():\n`;
    const syms = extractSymbolsFromPatch("util.py", patch);
    // decorator line itself is skipped
    expect(syms).not.toContain("staticmethod");
    expect(syms).toContain("helper");
  });

  test("comment not extracted", () => {
    const patch = `@@ -0,0 +1,2 @@\n+# def commented_out():\n+def real_fn():\n`;
    const syms = extractSymbolsFromPatch("util.py", patch);
    expect(syms).not.toContain("commented_out");
    expect(syms).toContain("real_fn");
  });
});

describe("extractSymbolsFromPatch — Go", () => {
  test("plain func", () => {
    const patch = `@@ -0,0 +1 @@\n+func CreateWidget(name string) *Widget {\n`;
    expect(extractSymbolsFromPatch("pkg/widget.go", patch)).toContain("CreateWidget");
  });

  test("func with receiver (method)", () => {
    const patch = `@@ -0,0 +1 @@\n+func (w *Widget) Validate() error {\n`;
    expect(extractSymbolsFromPatch("pkg/widget.go", patch)).toContain("Validate");
  });

  test("func with value receiver", () => {
    const patch = `@@ -0,0 +1 @@\n+func (s Store) Find(id string) (Item, error) {\n`;
    expect(extractSymbolsFromPatch("store.go", patch)).toContain("Find");
  });

  test("comment line not extracted", () => {
    const patch = `@@ -0,0 +1,2 @@\n+// func Commented() {}\n+func Real() {}\n`;
    const syms = extractSymbolsFromPatch("util.go", patch);
    expect(syms).not.toContain("Commented");
    expect(syms).toContain("Real");
  });
});

describe("extractSymbolsFromPatch — Java", () => {
  test("public method", () => {
    const patch = `@@ -0,0 +1 @@\n+  public Widget createWidget(String name) {\n`;
    expect(extractSymbolsFromPatch("src/Factory.java", patch)).toContain("createWidget");
  });

  test("private static method", () => {
    const patch = `@@ -0,0 +1 @@\n+  private static boolean validate(Object obj) {\n`;
    expect(extractSymbolsFromPatch("src/Validator.java", patch)).toContain("validate");
  });

  test("public class declaration", () => {
    const patch = `@@ -0,0 +1 @@\n+public class WidgetFactory {\n`;
    expect(extractSymbolsFromPatch("src/WidgetFactory.java", patch)).toContain("WidgetFactory");
  });

  test("interface declaration", () => {
    const patch = `@@ -0,0 +1 @@\n+public interface Processor {\n`;
    expect(extractSymbolsFromPatch("src/Processor.java", patch)).toContain("Processor");
  });
});

describe("extractSymbolsFromPatch — edge cases", () => {
  test("unsupported language returns empty", () => {
    const patch = `@@ -0,0 +1 @@\n+function foo() {}\n`;
    expect(extractSymbolsFromPatch("code.rb", patch)).toHaveLength(0);
  });

  test("empty patch returns empty", () => {
    expect(extractSymbolsFromPatch("src/api.ts", "")).toHaveLength(0);
  });

  test("patch with no added lines returns empty", () => {
    const patch = `@@ -1 +1 @@\n-old line\n context line\n`;
    expect(extractSymbolsFromPatch("src/api.ts", patch)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeCoverageDelta
// ---------------------------------------------------------------------------

function makeFile(
  overrides: Partial<PullRequestFile> & { filename: string; additions: number },
): PullRequestFile {
  return {
    status: "added",
    deletions: 0,
    changes: overrides.additions,
    patch: "",
    ...overrides,
  };
}

describe("computeCoverageDelta", () => {
  test("empty file list returns zero delta", () => {
    const delta = computeCoverageDelta([]);
    expect(delta.addedSrcLines).toBe(0);
    expect(delta.addedTestLines).toBe(0);
    expect(delta.ratio).toBe(0);
    expect(delta.flaggedSymbols).toHaveLength(0);
  });

  test("only doc files — no src or test lines", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "README.md", additions: 50 }),
    ]);
    expect(delta.addedSrcLines).toBe(0);
    expect(delta.addedTestLines).toBe(0);
  });

  test("src lines counted from source files", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "src/api.ts", additions: 30 }),
      makeFile({ filename: "src/util.ts", additions: 20 }),
    ]);
    expect(delta.addedSrcLines).toBe(50);
  });

  test("test lines counted from test files", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "src/api.ts", additions: 50 }),
      makeFile({ filename: "src/api.test.ts", additions: 20 }),
    ]);
    expect(delta.addedTestLines).toBe(20);
  });

  test("ratio is correct", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "src/api.ts", additions: 100 }),
      makeFile({ filename: "src/api.test.ts", additions: 50 }),
    ]);
    expect(delta.ratio).toBeCloseTo(0.5);
  });

  test("ratio is 0 when addedSrcLines is 0", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "README.md", additions: 10 }),
    ]);
    expect(delta.ratio).toBe(0);
  });

  test("symbols flagged when no test lines added", () => {
    const patch = `@@ -0,0 +1 @@\n+export function doThing() {\n`;
    const delta = computeCoverageDelta([
      makeFile({ filename: "src/thing.ts", additions: 5, patch }),
    ]);
    expect(delta.addedTestLines).toBe(0);
    expect(delta.flaggedSymbols.length).toBeGreaterThan(0);
    expect(delta.flaggedSymbols[0]?.symbol).toBe("doThing");
    expect(delta.flaggedSymbols[0]?.file).toBe("src/thing.ts");
  });

  test("symbols NOT flagged when test lines were added", () => {
    const patch = `@@ -0,0 +1 @@\n+export function doThing() {\n`;
    const delta = computeCoverageDelta([
      makeFile({ filename: "src/thing.ts", additions: 5, patch }),
      makeFile({ filename: "src/thing.test.ts", additions: 10 }),
    ]);
    // Some test effort was made — we don't enumerate all symbols
    expect(delta.flaggedSymbols).toHaveLength(0);
  });

  test("config files do not contribute to src or test counts", () => {
    const delta = computeCoverageDelta([
      makeFile({ filename: "tsconfig.json", additions: 5 }),
      makeFile({ filename: "src/api.ts", additions: 10 }),
    ]);
    expect(delta.addedSrcLines).toBe(10);
    expect(delta.addedTestLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: 100 src lines + 0 test lines — prompt signal scenario
// ---------------------------------------------------------------------------

describe("computeCoverageDelta — integration", () => {
  test("100 src lines + 0 test lines produces signal with flagged symbols", () => {
    const patch =
      `@@ -0,0 +1,5 @@\n` +
      `+export function alpha() { return 1; }\n` +
      `+export function beta() { return 2; }\n` +
      `+export class Gamma {}\n` +
      `+export const delta = () => 4;\n` +
      `+// comment\n`;

    const files: PullRequestFile[] = [
      {
        filename: "src/module.ts",
        status: "added",
        additions: 100,
        deletions: 0,
        changes: 100,
        patch,
      },
    ];

    const delta = computeCoverageDelta(files);

    expect(delta.addedSrcLines).toBe(100);
    expect(delta.addedTestLines).toBe(0);
    expect(delta.flaggedSymbols.length).toBeGreaterThanOrEqual(1);
    // Verify the shape of flagged symbols
    for (const s of delta.flaggedSymbols) {
      expect(s.file).toBe("src/module.ts");
      expect(typeof s.symbol).toBe("string");
      expect(s.symbol.length).toBeGreaterThan(0);
    }
  });
});
