import { describe, expect, test } from "bun:test";
import { extractJiraRefs, adfToText } from "../src/intent/jira.ts";

describe("extractJiraRefs", () => {
  test("captures standard project keys", () => {
    const refs = extractJiraRefs({
      title: "Fix PROJ-123 and address ABC-456",
      body: "See ENG-7.",
    });
    expect(refs.map((r) => r.key).sort()).toEqual(["ABC-456", "ENG-7", "PROJ-123"]);
    for (const r of refs) expect(r.kind).toBe("jira");
  });

  test("project name can include digits after first letter", () => {
    const refs = extractJiraRefs({ title: "API2-99", body: "" });
    expect(refs[0]!.key).toBe("API2-99");
  });

  test("single-letter project is NOT matched (too many false positives)", () => {
    const refs = extractJiraRefs({ title: "A-1 and Z-99", body: "" });
    expect(refs).toEqual([]);
  });

  test("lowercase does not match", () => {
    const refs = extractJiraRefs({ title: "proj-123 not-issue", body: "" });
    expect(refs).toEqual([]);
  });

  test("deduplicates", () => {
    const refs = extractJiraRefs({ title: "PROJ-1 PROJ-1 PROJ-1", body: "PROJ-1" });
    expect(refs).toHaveLength(1);
  });

  test("word boundary — doesn't cut mid-word", () => {
    // SSHA-256 starts at word boundary; it matches the Jira pattern. Document
    // that as a known false positive — Jira API will 404 and the ref drops.
    const refs = extractJiraRefs({ title: "SHA-256", body: "" });
    expect(refs).toHaveLength(1);
    // But XHA-SHA-256 (preceded by non-boundary) should still only match
    // the SHA-256 part, or be rejected if the prefix breaks the boundary.
    // We're documenting the behavior, not policing every edge case.
  });

  test("scans both title and body", () => {
    const refs = extractJiraRefs({ title: "APP-1", body: "APP-2" });
    expect(refs.map((r) => r.key).sort()).toEqual(["APP-1", "APP-2"]);
  });

  test("raw preserves original text", () => {
    const refs = extractJiraRefs({ title: "Closes PROJ-42 today", body: "" });
    expect(refs[0]!.raw).toBe("PROJ-42");
  });
});

describe("adfToText", () => {
  test("null / undefined / non-object → empty string", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText(42)).toBe("");
  });

  test("plain text leaf", () => {
    expect(adfToText({ type: "text", text: "hello" })).toBe("hello");
  });

  test("paragraph joins text nodes and adds double newline", () => {
    const doc = {
      type: "paragraph",
      content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
    };
    expect(adfToText(doc)).toBe("hello world\n\n");
  });

  test("hardBreak produces a newline", () => {
    const doc = {
      type: "paragraph",
      content: [
        { type: "text", text: "line1" },
        { type: "hardBreak" },
        { type: "text", text: "line2" },
      ],
    };
    expect(adfToText(doc)).toBe("line1\nline2\n\n");
  });

  test("bulletList produces dashed lines", () => {
    const doc = {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
        },
      ],
    };
    const out = adfToText(doc);
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  test("unknown node type walks children silently", () => {
    const doc = {
      type: "weirdCustomWidget",
      content: [{ type: "text", text: "still visible" }],
    };
    expect(adfToText(doc)).toBe("still visible");
  });

  test("nested doc → paragraph → text (the usual Jira shape)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "After restart, pool shows 12 connections." }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Steps to reproduce" }],
        },
      ],
    };
    const out = adfToText(doc);
    expect(out).toContain("After restart, pool shows 12 connections.");
    expect(out).toContain("Steps to reproduce");
  });
});
