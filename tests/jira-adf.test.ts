import { describe, expect, test } from "bun:test";
import { adfToText } from "../src/jira/adf";

describe("adfToText", () => {
  test("returns empty string for null/undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  test("flattens a simple paragraph", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    };
    expect(adfToText(adf).trim()).toBe("Hello world");
  });

  test("handles bullet lists", () => {
    const adf = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
      ],
    };
    const out = adfToText(adf);
    expect(out).toContain("- one");
    expect(out).toContain("- two");
  });

  test("handles hard breaks", () => {
    const adf = {
      type: "paragraph",
      content: [
        { type: "text", text: "line1" },
        { type: "hardBreak" },
        { type: "text", text: "line2" },
      ],
    };
    expect(adfToText(adf).trim()).toBe("line1\nline2");
  });
});
