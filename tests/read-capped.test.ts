import { describe, expect, test } from "bun:test";
import { readCapped } from "../src/claude/invoke.ts";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i += 1;
      } else {
        controller.close();
      }
    },
  });
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("readCapped", () => {
  test("reads a small stream under the cap", async () => {
    const r = await readCapped(streamOf([bytes("hello "), bytes("world")]), 1024);
    expect(r.text).toBe("hello world");
    expect(r.overflow).toBe(false);
  });

  test("marks overflow when total bytes exceed the cap", async () => {
    // 10 bytes per chunk × 11 chunks = 110 bytes, cap 50.
    const chunks = Array.from({ length: 11 }, () => bytes("abcdefghij"));
    const r = await readCapped(streamOf(chunks), 50);
    expect(r.overflow).toBe(true);
    // Under-cap prefix should still be present (not required to be exact).
    expect(r.text.length).toBeLessThanOrEqual(50);
  });

  test("handles multi-byte utf-8 split across chunks", async () => {
    // "€" = 0xE2 0x82 0xAC — split it between two chunks. readCapped uses a
    // streaming TextDecoder so the character reassembles correctly.
    const r = await readCapped(
      streamOf([new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac])]),
      1024,
    );
    expect(r.text).toBe("€");
    expect(r.overflow).toBe(false);
  });

  test("empty stream yields empty string, no overflow", async () => {
    const r = await readCapped(streamOf([]), 100);
    expect(r.text).toBe("");
    expect(r.overflow).toBe(false);
  });

  test("exactly-at-cap is not overflow", async () => {
    const r = await readCapped(streamOf([bytes("x".repeat(10))]), 10);
    expect(r.text).toBe("x".repeat(10));
    expect(r.overflow).toBe(false);
  });
});
