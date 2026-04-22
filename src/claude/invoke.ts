import { ReviewResult } from "./schema.ts";

export type InvokeArgs = {
  command: string;
  prompt: string;
  timeoutSeconds: number;
};

export type InvokeResult =
  | { ok: true; review: ReviewResult; rawBytes: number }
  | { ok: false; error: string; stderr?: string; stdoutSample?: string };

export async function invokeClaude(args: InvokeArgs): Promise<InvokeResult> {
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

  let stdout = "";
  let stderr = "";
  const exit = await proc.exited.then((code) => code).catch(() => -1);
  clearTimeout(timer);

  stdout = await new Response(proc.stdout).text();
  stderr = await new Response(proc.stderr).text();

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

  const result = ReviewResult.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: `schema mismatch: ${result.error.issues.map((i) => i.message).join("; ")}`,
      stdoutSample: json.slice(0, 1000),
    };
  }

  return { ok: true, review: result.data, rawBytes: stdout.length };
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
