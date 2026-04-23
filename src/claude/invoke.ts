import { z } from "zod";
import { ReviewResult } from "./schema.ts";

/**
 * Upper bound on how much stdout we'll buffer from `claude -p` before we
 * kill the child and abort. A healthy review response is tens of KB; 2MB
 * leaves plenty of headroom for a pathological but legitimate output
 * without letting a stuck process chew unbounded RAM.
 */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
/** stderr is only used for diagnostics; keep a small cap. */
const MAX_STDERR_BYTES = 64 * 1024;

export type InvokeArgs = {
  command: string;
  prompt: string;
  timeoutSeconds: number;
};

export type InvokeResult =
  | { ok: true; review: ReviewResult; rawBytes: number }
  | { ok: false; error: string; stderr?: string; stdoutSample?: string };

/** Thin wrapper over the generic invoker for the normal review prompt. */
export async function invokeClaude(args: InvokeArgs): Promise<InvokeResult> {
  const r = await invokeClaudeJson({ ...args, schema: ReviewResult });
  if (r.ok) return { ok: true, review: r.data, rawBytes: r.rawBytes };
  return r;
}

/**
 * Spawn claude -p, enforce timeouts + stdout size caps, parse one JSON
 * object from stdout, validate against the supplied zod schema. Shared by
 * every Claude invocation (review, triage, future prompts) so the
 * infrastructure doesn't drift between callers.
 */
export async function invokeClaudeJson<T>(args: InvokeArgs & {
  schema: z.ZodType<T>;
}): Promise<
  | { ok: true; data: T; rawBytes: number }
  | { ok: false; error: string; stderr?: string; stdoutSample?: string }
> {
  const proc = Bun.spawn({
    cmd: [args.command, "-p", "--output-format", "text"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(args.prompt);
  await proc.stdin.end();

  const timer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  }, args.timeoutSeconds * 1_000);

  // Read stdout bounded — a misbehaving Claude (stuck loop, hallucinated
  // mega-JSON) could otherwise buffer indefinitely into JS heap. stderr has
  // its own small cap since we only use the first ~4KB for diagnostics.
  const [stdoutRead, stderrRead] = await Promise.all([
    readCapped(proc.stdout, MAX_STDOUT_BYTES),
    readCapped(proc.stderr, MAX_STDERR_BYTES),
  ]);
  const exit = await proc.exited.then((code) => code).catch(() => -1);
  clearTimeout(timer);

  if (stdoutRead.overflow) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
    return {
      ok: false,
      error: `claude stdout exceeded ${MAX_STDOUT_BYTES} bytes; aborting`,
      stderr: stderrRead.text.slice(0, 4000),
      stdoutSample: stdoutRead.text.slice(0, 1000),
    };
  }

  const stdout = stdoutRead.text;
  const stderr = stderrRead.text;

  if (exit !== 0) {
    return {
      ok: false,
      error: `claude exited with code ${exit}`,
      stderr: stderr.slice(0, 4000),
      stdoutSample: stdout.slice(0, 1000),
    };
  }

  const json = extractJsonObject(stdout);
  if (!json) {
    return {
      ok: false,
      error: "could not locate JSON object in claude stdout",
      stdoutSample: stdout.slice(0, 1000),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return {
      ok: false,
      error: `JSON parse failed: ${(e as Error).message}`,
      stdoutSample: json.slice(0, 1000),
    };
  }

  const result = args.schema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `schema mismatch: ${result.error.issues.map((i) => i.message).join("; ")}`,
      stdoutSample: json.slice(0, 1000),
    };
  }

  return { ok: true, data: result.data, rawBytes: stdout.length };
}

/**
 * Pull the first balanced top-level JSON object out of Claude's stdout.
 * `claude -p` may prepend/append framing text depending on the output format;
 * this finds the outermost { ... } by brace counting (ignoring braces inside strings).
 */
export function extractJsonObject(s: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Drain a ReadableStream<Uint8Array> into a UTF-8 string, bailing out once
 * the byte total exceeds `cap`. Returns `{ text, overflow }` — callers
 * decide what to do with an overflow (invokeClaude kills the child). The
 * stream is fully consumed even when we'd truncate, so the underlying file
 * descriptor doesn't keep feeding a pipe nobody's draining.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ text: string; overflow: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        overflow = true;
        // Don't accumulate any more text, but keep consuming the stream so
        // the producer can flush and exit cleanly.
        continue;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    if (!overflow) chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return { text: chunks.join(""), overflow };
}
