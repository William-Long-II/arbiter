import { describe, expect, test } from "bun:test";
import { evaluateCheckRuns } from "../src/github/checks";

describe("evaluateCheckRuns", () => {
  test("green when every run completed successfully", () => {
    const result = evaluateCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "success" },
    ]);
    expect(result.green).toBe(true);
  });

  test("allows neutral and skipped conclusions", () => {
    const result = evaluateCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "neutral" },
      { name: "mobile", status: "completed", conclusion: "skipped" },
    ]);
    expect(result.green).toBe(true);
  });

  test("fails with failingChecks on failure", () => {
    const result = evaluateCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ]);
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.failingChecks).toEqual(["test"]);
    }
  });

  test("fails when a run is still in progress", () => {
    const result = evaluateCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "deploy", status: "in_progress", conclusion: null },
    ]);
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.failingChecks).toEqual(["deploy"]);
    }
  });

  test("fails when there are no runs at all", () => {
    const result = evaluateCheckRuns([]);
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.reason).toMatch(/no check runs/);
    }
  });

  test("treats cancelled and timed_out as failures", () => {
    const result = evaluateCheckRuns([
      { name: "cancelled-job", status: "completed", conclusion: "cancelled" },
      { name: "timed-out", status: "completed", conclusion: "timed_out" },
    ]);
    expect(result.green).toBe(false);
    if (!result.green) {
      expect(result.failingChecks).toContain("cancelled-job");
      expect(result.failingChecks).toContain("timed-out");
    }
  });
});
