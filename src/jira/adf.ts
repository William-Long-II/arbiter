/**
 * Minimal Atlassian Document Format (ADF) -> plain text walker.
 * Good enough to feed Jira descriptions into an LLM prompt; not a
 * full renderer (tables collapse to a single paragraph, media is dropped).
 */

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string }>;
};

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "rule",
  "panel",
  "taskItem",
  "taskList",
]);

export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";

  const n = node as AdfNode;

  if (n.type === "text" && typeof n.text === "string") {
    return n.text;
  }
  if (n.type === "hardBreak") return "\n";
  if (n.type === "rule") return "\n---\n";

  const childText = (n.content ?? []).map(adfToText).join("");

  if (n.type === "listItem") return `- ${childText.trim()}\n`;
  if (n.type && BLOCK_TYPES.has(n.type)) {
    return `${childText}\n`;
  }

  return childText;
}
