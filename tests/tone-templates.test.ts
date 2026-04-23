import { describe, expect, test } from "bun:test";
import { applyToneTemplates, type ToneTemplate } from "../src/review/tone-templates.ts";
import type { FileDiff } from "../src/github/diff.ts";

function f(path: string): FileDiff {
  return {
    path,
    patch: "x",
    rightLines: new Set<number>(),
    leftLines: new Set<number>(),
    status: "modified",
  };
}

const files: FileDiff[] = [
  f("infra/main.tf"),
  f("infra/variables.tf"),
  f("db/migrations/2026_add_col.sql"),
  f("src/components/Button.tsx"),
  f("README.md"),
];

const tTf: ToneTemplate = {
  id: 1,
  pattern: "**/*.tf",
  tone_addendum: "Terraform: review for IaC security, state locks, hardcoded secrets.",
  priority: 0,
};
const tMigration: ToneTemplate = {
  id: 2,
  pattern: "**/migrations/**",
  tone_addendum: "Migrations: flag big-table locks, missing backfill, unsafe renames.",
  priority: 5,
};
const tTsx: ToneTemplate = {
  id: 3,
  pattern: "**/*.tsx",
  tone_addendum: "React: check a11y, keyboard nav, suspicious memoization.",
  priority: 10,
};
const tUnused: ToneTemplate = {
  id: 4,
  pattern: "**/*.go",
  tone_addendum: "Go guidance that never fires in this PR.",
  priority: 1,
};

describe("applyToneTemplates", () => {
  test("empty templates list — tone untouched, applied empty", () => {
    const r = applyToneTemplates({ baseTone: "base", files, templates: [] });
    expect(r.tone).toBe("base");
    expect(r.applied).toEqual([]);
  });

  test("no matching templates — tone untouched, applied empty", () => {
    const r = applyToneTemplates({
      baseTone: "base",
      files: [f("README.md")],
      templates: [tTf, tMigration],
    });
    expect(r.tone).toBe("base");
    expect(r.applied).toEqual([]);
  });

  test("single template fires, addendum appears after base", () => {
    const r = applyToneTemplates({
      baseTone: "BASE",
      files: [f("infra/a.tf")],
      templates: [tTf],
    });
    expect(r.tone).toContain("BASE");
    expect(r.tone).toContain("Terraform: review for IaC security");
    expect(r.tone.indexOf("BASE")).toBeLessThan(
      r.tone.indexOf("Terraform: review for IaC security"),
    );
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]!.id).toBe(1);
    expect(r.applied[0]!.matched_paths).toEqual(["infra/a.tf"]);
    expect(r.applied[0]!.matched_count).toBe(1);
  });

  test("multiple templates fire, higher priority appears later in tone", () => {
    const r = applyToneTemplates({
      baseTone: "B",
      files,
      templates: [tTsx, tTf, tMigration, tUnused], // unordered input
    });
    const idxTf = r.tone.indexOf("Terraform");
    const idxMig = r.tone.indexOf("Migrations");
    const idxTsx = r.tone.indexOf("React");
    expect(idxTf).toBeGreaterThan(-1);
    expect(idxMig).toBeGreaterThan(-1);
    expect(idxTsx).toBeGreaterThan(-1);
    // priority 0 (tf) < 5 (mig) < 10 (tsx) → ascending order in final tone
    expect(idxTf).toBeLessThan(idxMig);
    expect(idxMig).toBeLessThan(idxTsx);
    // Go template never matched, never appears
    expect(r.tone).not.toContain("Go guidance");

    const ids = r.applied.map((a) => a.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("multi-file match reports every matched path", () => {
    const r = applyToneTemplates({
      baseTone: "",
      files,
      templates: [tTf],
    });
    expect(r.applied[0]!.matched_paths.sort()).toEqual(["infra/main.tf", "infra/variables.tf"]);
    expect(r.applied[0]!.matched_count).toBe(2);
  });

  test("matched_paths caps at 20 but matched_count reports real total", () => {
    const many = Array.from({ length: 50 }, (_, i) => f(`infra/f${i}.tf`));
    const r = applyToneTemplates({
      baseTone: "",
      files: many,
      templates: [tTf],
    });
    expect(r.applied[0]!.matched_paths).toHaveLength(20);
    expect(r.applied[0]!.matched_count).toBe(50);
  });

  test("empty base tone — addendum still rendered without 'base\\n\\n' prefix", () => {
    const r = applyToneTemplates({
      baseTone: "",
      files: [f("a.tf")],
      templates: [tTf],
    });
    expect(r.tone.startsWith("Additional guidance")).toBe(true);
  });

  test("addendum with only whitespace is dropped from output but still counts as applied", () => {
    const tBlank: ToneTemplate = { id: 9, pattern: "**/*.md", tone_addendum: "   ", priority: 0 };
    const r = applyToneTemplates({
      baseTone: "B",
      files: [f("README.md")],
      templates: [tBlank],
    });
    // Matched → applied is populated (useful for UI even though text was empty)
    expect(r.applied).toHaveLength(1);
    // But no addendum text means tone stays as base
    expect(r.tone).toBe("B");
  });

  test("ties in priority — insertion order preserved", () => {
    const a: ToneTemplate = { id: 1, pattern: "**/*.tf", tone_addendum: "A", priority: 5 };
    const b: ToneTemplate = { id: 2, pattern: "**/*.tf", tone_addendum: "B", priority: 5 };
    const r = applyToneTemplates({
      baseTone: "",
      files: [f("x.tf")],
      templates: [a, b],
    });
    expect(r.tone.indexOf("- A")).toBeLessThan(r.tone.indexOf("- B"));
  });
});
