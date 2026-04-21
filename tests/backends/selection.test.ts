/**
 * Tests for backend selection via LLM_BACKEND environment variable.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ApiBackend } from "../../src/review/backends/api";
import { ClaudeCliBackend } from "../../src/review/backends/claude-cli";
import { getReviewBackend, _resetBackends } from "../../src/review/backends";
import type Anthropic from "@anthropic-ai/sdk";

const fakeClient = {
  messages: { parse: async () => ({ parsed_output: null, usage: {} }) },
} as unknown as Anthropic;

describe("getReviewBackend - selection", () => {
  const originalBackend = process.env["LLM_BACKEND"];

  beforeEach(() => {
    _resetBackends();
  });

  afterEach(() => {
    // Restore env
    if (originalBackend === undefined) {
      delete process.env["LLM_BACKEND"];
    } else {
      process.env["LLM_BACKEND"] = originalBackend;
    }
    _resetBackends();
  });

  test("returns ApiBackend when LLM_BACKEND=api", () => {
    process.env["LLM_BACKEND"] = "api";
    const backend = getReviewBackend(fakeClient);
    expect(backend).toBeInstanceOf(ApiBackend);
  });

  test("returns ApiBackend when LLM_BACKEND is unset", () => {
    delete process.env["LLM_BACKEND"];
    const backend = getReviewBackend(fakeClient);
    expect(backend).toBeInstanceOf(ApiBackend);
  });

  test("returns ClaudeCliBackend when LLM_BACKEND=claude-cli", () => {
    process.env["LLM_BACKEND"] = "claude-cli";
    const backend = getReviewBackend();
    expect(backend).toBeInstanceOf(ClaudeCliBackend);
  });

  test("throws when LLM_BACKEND=api and no client provided", () => {
    process.env["LLM_BACKEND"] = "api";
    expect(() => getReviewBackend()).toThrow("Anthropic client is required");
  });

  test("returns same ApiBackend singleton on repeated calls", () => {
    process.env["LLM_BACKEND"] = "api";
    const b1 = getReviewBackend(fakeClient);
    // Subsequent call without client reuses the singleton
    const b2 = getReviewBackend();
    expect(b1).toBe(b2);
  });

  test("returns fresh ApiBackend when caller supplies a different client", () => {
    process.env["LLM_BACKEND"] = "api";
    const b1 = getReviewBackend(fakeClient);
    const b2 = getReviewBackend(fakeClient);
    // When a client is supplied, a new instance is always returned
    // (to honour per-repo overrides).
    expect(b2).not.toBe(b1);
  });

  test("returns same ClaudeCliBackend singleton on repeated calls", () => {
    process.env["LLM_BACKEND"] = "claude-cli";
    const b1 = getReviewBackend();
    const b2 = getReviewBackend();
    expect(b1).toBe(b2);
  });
});
