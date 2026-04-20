import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllowlist } from "../src/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hot-reload-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Hot-reload — basic (repos only, no orgs)
// ---------------------------------------------------------------------------

describe("hot-reload — repos-only", () => {
  test("reload() picks up a new repo added to disk", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(path, "repos:\n  acme/widget:\n    enabled: true\n");
      const holder = loadAllowlist(path);

      expect(holder.isAllowed("acme/widget")).toBe(true);
      expect(holder.isAllowed("acme/new-service")).toBe(false);

      writeFileSync(
        path,
        "repos:\n  acme/widget:\n    enabled: true\n  acme/new-service:\n    enabled: true\n",
      );
      holder.reload();

      expect(holder.isAllowed("acme/new-service")).toBe(true);
    });
  });

  test("reload() reflects a repo being disabled on disk", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(path, "repos:\n  acme/widget:\n    enabled: true\n");
      const holder = loadAllowlist(path);
      expect(holder.isAllowed("acme/widget")).toBe(true);

      writeFileSync(path, "repos:\n  acme/widget:\n    enabled: false\n");
      holder.reload();

      expect(holder.isAllowed("acme/widget")).toBe(false);
    });
  });

  test("reload() on parse error leaves old snapshot intact", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(path, "repos:\n  acme/widget:\n    enabled: true\n");
      const holder = loadAllowlist(path);
      expect(holder.isAllowed("acme/widget")).toBe(true);

      // Write invalid YAML that will fail Zod parsing.
      writeFileSync(path, "repos:\n  acme/widget:\n    enabled: not-a-boolean\n");
      expect(() => holder.reload()).toThrow();

      // Old snapshot must still be active.
      expect(holder.isAllowed("acme/widget")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Hot-reload — org defaults
// ---------------------------------------------------------------------------

describe("hot-reload — org defaults", () => {
  test("reload() propagates a changed org default to repos relying on that org", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(
        path,
        [
          "orgs:",
          "  acme:",
          "    enabled: true",
          "    rereview: auto-on-sync",
          "repos: {}",
        ].join("\n"),
      );
      const holder = loadAllowlist(path);

      expect(holder.isAllowed("acme/widget")).toBe(true);
      expect(holder.getEffectiveConfig("acme/widget")?.rereview).toBe("auto-on-sync");

      // Operator updates the org default on disk.
      writeFileSync(
        path,
        [
          "orgs:",
          "  acme:",
          "    enabled: true",
          "    rereview: label-or-mention",
          "    rereview_label: please-review",
          "repos: {}",
        ].join("\n"),
      );
      holder.reload();

      const cfg = holder.getEffectiveConfig("acme/widget");
      expect(cfg?.rereview).toBe("label-or-mention");
      expect(cfg?.rereview_label).toBe("please-review");
    });
  });

  test("reload() propagates adding an org that makes repos allowed", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(path, "repos: {}\n");
      const holder = loadAllowlist(path);
      expect(holder.isAllowed("acme/widget")).toBe(false);

      writeFileSync(
        path,
        ["orgs:", "  acme:", "    enabled: true", "repos: {}"].join("\n"),
      );
      holder.reload();

      expect(holder.isAllowed("acme/widget")).toBe(true);
    });
  });

  test("reload() propagates removing an org (repos no longer allowed)", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(
        path,
        ["orgs:", "  acme:", "    enabled: true", "repos: {}"].join("\n"),
      );
      const holder = loadAllowlist(path);
      expect(holder.isAllowed("acme/widget")).toBe(true);

      writeFileSync(path, "repos: {}\n");
      holder.reload();

      expect(holder.isAllowed("acme/widget")).toBe(false);
    });
  });

  test("reload() on parse error leaves org defaults intact", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(
        path,
        ["orgs:", "  acme:", "    enabled: true", "repos: {}"].join("\n"),
      );
      const holder = loadAllowlist(path);
      expect(holder.isAllowed("acme/widget")).toBe(true);

      // Write a file that will fail Zod validation.
      writeFileSync(
        path,
        ["orgs:", "  acme:", "    enabled: not-a-bool", "repos: {}"].join("\n"),
      );
      expect(() => holder.reload()).toThrow();

      // Old snapshot — org still active.
      expect(holder.isAllowed("acme/widget")).toBe(true);
    });
  });

  test("reload() with org-level review.exclude_paths change propagates", () => {
    withTempDir((dir) => {
      const path = join(dir, "repos.yaml");
      writeFileSync(
        path,
        [
          "orgs:",
          "  acme:",
          "    enabled: true",
          "    review:",
          '      exclude_paths: ["docs/**"]',
          "repos: {}",
        ].join("\n"),
      );
      const holder = loadAllowlist(path);
      expect(holder.getEffectiveConfig("acme/widget")?.review?.exclude_paths).toEqual(["docs/**"]);

      writeFileSync(
        path,
        [
          "orgs:",
          "  acme:",
          "    enabled: true",
          "    review:",
          '      exclude_paths: ["docs/**", "*.md"]',
          "repos: {}",
        ].join("\n"),
      );
      holder.reload();

      expect(holder.getEffectiveConfig("acme/widget")?.review?.exclude_paths).toEqual([
        "docs/**",
        "*.md",
      ]);
    });
  });
});
