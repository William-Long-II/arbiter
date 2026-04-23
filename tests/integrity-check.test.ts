import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // leave it for the OS temp cleaner
      }
    },
  };
}

describe("integrity_check at boot", () => {
  test("fresh DB → integrity is null (nothing to check yet)", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.meta.freshlyCreated).toBe(true);
      expect(store.meta.integrity).toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });

  test("re-open existing healthy DB → integrity is 'ok'", () => {
    const { path, cleanup } = tmpDb();
    try {
      // First open creates the file; close so the second open sees preExisted=true.
      openStore(path).close();
      const store = openStore(path);
      expect(store.meta.freshlyCreated).toBe(false);
      expect(store.meta.integrity).toBe("ok");
      store.close();
    } finally {
      cleanup();
    }
  });

  // Note: there's no unit test here for the "corrupted DB → integrity
  // reports failure" branch. Reliably simulating SQLite corruption in a
  // test is surprisingly hard because WAL recovery masks most in-place
  // byte clobbering. The implementation's fail-safe shape (try/catch
  // around the PRAGMA plus a non-ok branch that pushes the diagnostic
  // into meta.integrity.error) is small and greppable, and the UI +
  // /healthz paths that act on the result ARE covered by the health
  // tests via direct HealthStatus inspection.
});
