import { describe, expect, test } from "bun:test";
import { extractGithubRefs } from "../src/intent/github.ts";

const OWN = { owner: "my-org", name: "my-repo" };

describe("extractGithubRefs", () => {
  test("plain #N references use the PR's own repo", () => {
    const refs = extractGithubRefs({
      title: "Fix the thing (closes #42)",
      body: "See also #100.",
      ownRepo: OWN,
    });
    expect(refs.map((r) => r.key)).toEqual(["my-org/my-repo#42", "my-org/my-repo#100"]);
    expect(refs[0]!.owner).toBe("my-org");
    expect(refs[0]!.repoName).toBe("my-repo");
    expect(refs[0]!.number).toBe(42);
  });

  test("owner/repo#N cross-repo references are captured with their own owner/repo", () => {
    const refs = extractGithubRefs({
      title: "Fixes acme/widget#7 and upstream/lib#12",
      body: "",
      ownRepo: OWN,
    });
    expect(refs.map((r) => r.key)).toEqual(["acme/widget#7", "upstream/lib#12"]);
    expect(refs[0]!.owner).toBe("acme");
    expect(refs[0]!.repoName).toBe("widget");
  });

  test("dedup: same reference appearing multiple times collapses to one", () => {
    const refs = extractGithubRefs({
      title: "#1 #1",
      body: "Yes, #1 again.",
      ownRepo: OWN,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.key).toBe("my-org/my-repo#1");
  });

  test("pound with non-digit content is ignored (#foo, #)", () => {
    const refs = extractGithubRefs({
      title: "#foo and # and #123",
      body: "",
      ownRepo: OWN,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.number).toBe(123);
  });

  test("owner/repo chars tolerate dots, hyphens, underscores", () => {
    const refs = extractGithubRefs({
      title: "",
      body: "my.co/thing-a_b#99",
      ownRepo: OWN,
    });
    expect(refs).toHaveLength(1);
    expect(refs[0]!.owner).toBe("my.co");
    expect(refs[0]!.repoName).toBe("thing-a_b");
    expect(refs[0]!.number).toBe(99);
  });

  test("title and body are both scanned", () => {
    const refs = extractGithubRefs({
      title: "#1 in title",
      body: "#2 in body",
      ownRepo: OWN,
    });
    expect(refs.map((r) => r.number).sort()).toEqual([1, 2]);
  });

  test("empty input returns empty array", () => {
    expect(extractGithubRefs({ title: "", body: "", ownRepo: OWN })).toEqual([]);
  });

  test("multiple refs on one line, all extracted", () => {
    const refs = extractGithubRefs({
      title: "Merge #3, close #4, fix #5",
      body: "",
      ownRepo: OWN,
    });
    expect(refs.map((r) => r.number)).toEqual([3, 4, 5]);
  });

  test("raw field preserves the original text", () => {
    const refs = extractGithubRefs({
      title: "See acme/widget#7 (aside: #99)",
      body: "",
      ownRepo: OWN,
    });
    expect(refs[0]!.raw).toBe("acme/widget#7");
    expect(refs[1]!.raw).toBe("#99");
  });
});
