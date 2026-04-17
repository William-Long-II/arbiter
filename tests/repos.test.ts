import { describe, expect, test } from "bun:test";
import { buildAllowlist } from "../src/config/repos";

describe("buildAllowlist", () => {
  test("returns false for unknown repos", () => {
    const allow = buildAllowlist({});
    expect(allow.isAllowed("acme/widget")).toBe(false);
  });

  test("returns true for enabled repos and false for disabled", () => {
    const allow = buildAllowlist({
      "acme/widget": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
      },
      "acme/legacy": {
        enabled: false,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
      },
    });
    expect(allow.isAllowed("acme/widget")).toBe(true);
    expect(allow.isAllowed("acme/legacy")).toBe(false);
  });

  test("matches case-insensitively", () => {
    const allow = buildAllowlist({
      "Acme/Widget": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
      },
    });
    expect(allow.isAllowed("acme/widget")).toBe(true);
    expect(allow.isAllowed("ACME/WIDGET")).toBe(true);
  });

  test("get returns the entry with full config", () => {
    const allow = buildAllowlist({
      "acme/widget": {
        enabled: true,
        rereview: "label-or-mention",
        rereview_label: "plz-review",
      },
    });
    expect(allow.get("acme/widget")?.rereview).toBe("label-or-mention");
    expect(allow.get("acme/widget")?.rereview_label).toBe("plz-review");
  });
});
