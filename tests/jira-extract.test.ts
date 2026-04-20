import { describe, expect, test } from "bun:test";
import { extractTicketKey } from "../src/jira/extract";

describe("extractTicketKey", () => {
  test("finds key in title", () => {
    expect(extractTicketKey({ title: "PROJ-123: fix bug" })).toBe("PROJ-123");
  });

  test("finds key in branch (case-insensitive)", () => {
    expect(
      extractTicketKey({ branch: "feature/proj-456-add-thing" }),
    ).toBe("PROJ-456");
  });

  test("finds key in body when title and branch have none", () => {
    expect(
      extractTicketKey({
        title: "fix bug",
        branch: "fix-bug",
        body: "Relates to ABC-9 and XYZ-10",
      }),
    ).toBe("ABC-9");
  });

  test("prefers title over branch over body", () => {
    expect(
      extractTicketKey({
        title: "TITLE-1",
        branch: "feat/branch-2",
        body: "body BODY-3",
      }),
    ).toBe("TITLE-1");
  });

  test("returns undefined when no match", () => {
    expect(
      extractTicketKey({ title: "fix things", branch: "main", body: "no keys" }),
    ).toBeUndefined();
  });

  test("does not match lowercase keys in title", () => {
    expect(extractTicketKey({ title: "proj-1 lowercase" })).toBeUndefined();
  });

  test("respects a custom pattern", () => {
    const custom = /ticket-\d+/i;
    expect(
      extractTicketKey(
        { title: "closes ticket-42" },
        custom,
      ),
    ).toBe("ticket-42");
  });
});
