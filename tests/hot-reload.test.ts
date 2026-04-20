/**
 * Tests for hot-reload (SIGHUP) config behaviour.
 *
 * Three scenarios:
 *   1. Atomic swap — concurrent getAllowlist() reads during a reload always
 *      return a fully-formed snapshot (never a partial / null).
 *   2. Parse-error retention — reload() with bad YAML leaves the previous
 *      snapshot intact and reports an error.
 *   3. Integration — simulating the SIGHUP handler: a newly-added repo is
 *      picked up by getAllowlist() after reload().
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import the internal module directly to control the holder state.
// Each test writes a temp file and calls loadReposFile() to seed the holder
// fresh, so tests are isolated.
import {
  buildAllowlist,
  getAllowlist,
  loadReposFile,
  reload,
} from "../src/config/repos";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let reposPath: string;

function writeRepos(content: string): void {
  writeFileSync(reposPath, content, "utf8");
}

function validYaml(repos: Record<string, { enabled?: boolean }>): string {
  const entries = Object.entries(repos)
    .map(([name, cfg]) => `  ${name}:\n    enabled: ${cfg.enabled ?? true}`)
    .join("\n");
  return `repos:\n${entries}\n`;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = join(tmpdir(), `hot-reload-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
  reposPath = join(tmpDir, "repos.yaml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Atomic swap
// ---------------------------------------------------------------------------

describe("atomic swap", () => {
  test("getAllowlist() always returns a fully-formed snapshot (never null/partial)", async () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    // Schedule many reads as microtasks alongside a reload.
    // JS is single-threaded: _holder = next is a single assignment — any call
    // to getAllowlist() sees either the old or the new complete snapshot, never
    // a torn/partial value.
    const readCount = 200;
    const readPromises: Array<Promise<boolean>> = [];

    for (let i = 0; i < readCount; i++) {
      readPromises.push(
        Promise.resolve().then(() => {
          const snapshot = getAllowlist();
          // A valid snapshot must have all three methods.
          return (
            typeof snapshot.isAllowed === "function" &&
            typeof snapshot.get === "function" &&
            typeof snapshot.all === "function"
          );
        }),
      );
    }

    writeRepos(validYaml({ "acme/widget": { enabled: true }, "acme/other": { enabled: true } }));
    const reloadResult = reload();

    const results = await Promise.all(readPromises);

    expect(reloadResult).toMatchObject({ ok: true });
    // Every read must have returned a fully-formed snapshot with all three methods.
    expect(results.every(Boolean)).toBe(true);
  });

  test("after reload, getAllowlist() returns the new snapshot", () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    expect(getAllowlist().isAllowed("acme/widget")).toBe(true);
    expect(getAllowlist().isAllowed("acme/new-repo")).toBe(false);

    writeRepos(validYaml({ "acme/widget": { enabled: true }, "acme/new-repo": { enabled: true } }));
    const result = reload();

    expect(result).toMatchObject({ ok: true, count: 2 });
    expect(getAllowlist().isAllowed("acme/new-repo")).toBe(true);
  });

  test("snapshot captured before reload still works for in-flight use", () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    // Capture reference before reload — simulates an in-flight event.
    const inFlightSnapshot = getAllowlist();

    writeRepos(validYaml({ "acme/other": { enabled: true } }));
    reload();

    // In-flight snapshot still reflects pre-reload state.
    expect(inFlightSnapshot.isAllowed("acme/widget")).toBe(true);
    expect(inFlightSnapshot.isAllowed("acme/other")).toBe(false);

    // Fresh reads see the new state.
    expect(getAllowlist().isAllowed("acme/widget")).toBe(false);
    expect(getAllowlist().isAllowed("acme/other")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Parse-error retention
// ---------------------------------------------------------------------------

describe("parse-error retention", () => {
  test("reload() with invalid YAML returns ok:false and keeps the old snapshot", () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    const snapshotBefore = getAllowlist();
    expect(snapshotBefore.isAllowed("acme/widget")).toBe(true);

    // Overwrite with unparseable content.
    writeRepos(": this is not valid yaml: {{{");
    const result = reload();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }

    // The holder must still point to the pre-reload snapshot.
    const snapshotAfter = getAllowlist();
    expect(snapshotAfter.isAllowed("acme/widget")).toBe(true);

    // Same object reference — the holder was not swapped.
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  test("reload() with schema-invalid YAML returns ok:false and keeps the old snapshot", () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    // Valid YAML but wrong schema.
    writeRepos("repos:\n  acme/widget:\n    enabled: not-a-boolean\n    rereview: bad-value\n");
    const result = reload();

    expect(result.ok).toBe(false);
    // Old snapshot preserved.
    expect(getAllowlist().isAllowed("acme/widget")).toBe(true);
  });

  test("reload() when file is missing returns ok:false and keeps the old snapshot", () => {
    writeRepos(validYaml({ "acme/widget": { enabled: true } }));
    loadReposFile(reposPath);

    // Remove the file.
    rmSync(reposPath);
    const result = reload();

    expect(result.ok).toBe(false);
    expect(getAllowlist().isAllowed("acme/widget")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Integration — simulate SIGHUP handler inline
// ---------------------------------------------------------------------------

describe("integration: SIGHUP simulation", () => {
  test("new repo in repos.yaml is picked up after reload without dropping queued events", async () => {
    writeRepos(validYaml({ "acme/existing": { enabled: true } }));
    loadReposFile(reposPath);

    // Simulate in-flight event that started before reload.
    const inFlightAllowlist = getAllowlist();

    // Operator adds a new repo.
    writeRepos(validYaml({
      "acme/existing": { enabled: true },
      "acme/added": { enabled: true },
    }));

    // Simulate SIGHUP handler firing.
    const result = reload();
    expect(result).toMatchObject({ ok: true, count: 2 });

    // Queued/in-flight event still works with its captured snapshot.
    expect(inFlightAllowlist.isAllowed("acme/existing")).toBe(true);
    expect(inFlightAllowlist.isAllowed("acme/added")).toBe(false); // not in pre-reload snapshot

    // New events pick up the updated allowlist.
    expect(getAllowlist().isAllowed("acme/added")).toBe(true);
    expect(getAllowlist().isAllowed("acme/existing")).toBe(true);
  });

  test("reload() reports correct count", () => {
    writeRepos(validYaml({
      "org/a": { enabled: true },
      "org/b": { enabled: true },
      "org/c": { enabled: false },
    }));
    loadReposFile(reposPath);

    // File now has 4 repos.
    writeRepos(validYaml({
      "org/a": { enabled: true },
      "org/b": { enabled: true },
      "org/c": { enabled: false },
      "org/d": { enabled: true },
    }));
    const result = reload();
    expect(result).toMatchObject({ ok: true, count: 4 });
  });
});

// ---------------------------------------------------------------------------
// 4. buildAllowlist — preserved behaviour (regression guard)
// ---------------------------------------------------------------------------

describe("buildAllowlist (regression)", () => {
  test("returns false for unknown repos", () => {
    const allow = buildAllowlist({});
    expect(allow.isAllowed("acme/widget")).toBe(false);
  });

  test("matches case-insensitively", () => {
    const allow = buildAllowlist({
      "Acme/Widget": { enabled: true, rereview: "auto-on-sync", rereview_label: "re-review" },
    });
    expect(allow.isAllowed("acme/widget")).toBe(true);
    expect(allow.isAllowed("ACME/WIDGET")).toBe(true);
  });
});
