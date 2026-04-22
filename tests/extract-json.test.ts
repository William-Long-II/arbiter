import { describe, expect, test } from "bun:test";
import { extractJsonObject } from "../src/claude/invoke.ts";

describe("extractJsonObject", () => {
  test("plain JSON", () => {
    const input = '{"a":1,"b":"two"}';
    expect(extractJsonObject(input)).toBe('{"a":1,"b":"two"}');
  });

  test("JSON surrounded by prose", () => {
    const input = 'Sure, here is the review:\n\n{"verdict":"approve"}\n\nLet me know.';
    expect(extractJsonObject(input)).toBe('{"verdict":"approve"}');
  });

  test("nested braces are handled", () => {
    const input = 'blah {"a":{"b":{"c":1}}} more';
    expect(extractJsonObject(input)).toBe('{"a":{"b":{"c":1}}}');
  });

  test("braces inside strings do not count", () => {
    const input = '{"body":"this { looks } balanced but is inside a string","x":1}';
    expect(extractJsonObject(input)).toBe(
      '{"body":"this { looks } balanced but is inside a string","x":1}',
    );
  });

  test("escaped quotes inside strings", () => {
    const input = '{"body":"he said \\"hi\\" {"}';
    expect(extractJsonObject(input)).toBe('{"body":"he said \\"hi\\" {"}');
  });

  test("no object returns null", () => {
    expect(extractJsonObject("no braces here")).toBeNull();
  });
});
