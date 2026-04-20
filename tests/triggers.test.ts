import { describe, expect, test } from "bun:test";
import {
  decideFromCheckSuite,
  mentionsReviewCommand,
} from "../src/server/triggers";

describe("decideFromCheckSuite", () => {
  test("auto-on-sync always proceeds", () => {
    expect(decideFromCheckSuite("auto-on-sync", false, false).proceed).toBe(true);
    expect(decideFromCheckSuite("auto-on-sync", true, false).proceed).toBe(true);
    expect(decideFromCheckSuite("auto-on-sync", true, true).proceed).toBe(true);
  });

  test("label-or-mention proceeds for the first review (no prior review)", () => {
    const result = decideFromCheckSuite("label-or-mention", false, false);
    expect(result.proceed).toBe(true);
  });

  test("label-or-mention waits when prior review exists and no label", () => {
    const result = decideFromCheckSuite("label-or-mention", true, false);
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toMatch(/awaiting.*label/);
    }
  });

  test("label-or-mention proceeds when prior review exists and label is present", () => {
    const result = decideFromCheckSuite("label-or-mention", true, true);
    expect(result.proceed).toBe(true);
  });
});

describe("mentionsReviewCommand", () => {
  test("matches /reviewme at start of body", () => {
    expect(mentionsReviewCommand("/reviewme please")).toBe(true);
  });

  test("matches /reviewme mid-body", () => {
    expect(mentionsReviewCommand("hey bot, /reviewme this thing")).toBe(true);
  });

  test("matches /reviewme at end of body", () => {
    expect(mentionsReviewCommand("can you take a look /reviewme")).toBe(true);
  });

  test("does not match a similar string", () => {
    expect(mentionsReviewCommand("/reviewmepls")).toBe(false);
    expect(mentionsReviewCommand("pre/reviewme")).toBe(false);
  });

  test("handles null/undefined/empty", () => {
    expect(mentionsReviewCommand(null)).toBe(false);
    expect(mentionsReviewCommand(undefined)).toBe(false);
    expect(mentionsReviewCommand("")).toBe(false);
  });
});
