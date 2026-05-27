#!/usr/bin/env bun
/**
 * macOS Keychain → ~/.claude/.credentials.json sync, plus the launchd
 * UserAgent that keeps the file fresh.
 *
 * Why this exists: in subscription-mode Docker we bind-mount the host's
 * ~/.claude/ into the container so `claude -p` can read its credentials.
 * On macOS the real creds live in the Keychain, not in a file, so setup
 * exports them into .credentials.json. But Anthropic rotates refresh
 * tokens — the moment anything else on the host refreshes (typically the
 * host's own `claude` CLI updating the Keychain), the refresh token in
 * the bind-mounted file is invalidated and the container starts 401ing.
 *
 * The recovery used to be "stop docker, re-run setup, restart docker."
 * Now the install-agent path drops a launchd UserAgent that resyncs the
 * Keychain into the file every ~5 minutes, so the file tracks whatever
 * is currently valid in the Keychain.
 *
 * CLI:
 *   refresh-creds                       # one-shot export (Keychain → file)
 *   refresh-creds --watch [seconds]     # loop forever (default 300s)
 *   refresh-creds --install-agent       # write+load launchd plist
 *   refresh-creds --uninstall-agent     # unload+remove launchd plist
 *
 * macOS-only. Calling install-agent on any other platform exits non-zero.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export const AGENT_LABEL = 'com.arbiter.creds-refresh';
export const DEFAULT_INTERVAL_SECONDS = 300;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface ExportResult {
  ok: boolean;
  /** Human-readable explanation. */
  detail: string;
}

/**
 * Read the Keychain item and atomically replace ~/.claude/.credentials.json.
 *
 * Atomic = write to a sibling tmp file, chmod 600, then rename. A crash
 * mid-export leaves the previous good file intact, not a half-written
 * one that breaks every container review.
 */
export function exportKeychainToFile(home: string = homedir()): ExportResult {
  if (platform() !== 'darwin') {
    return { ok: false, detail: `not macOS (platform=${platform()})` };
  }
  const credsFile = join(home, '.claude', '.credentials.json');
  const r = Bun.spawnSync(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  const blob = (r.stdout?.toString() ?? '').trim();
  if (r.exitCode !== 0 || !blob) {
    const err = r.stderr?.toString().trim() || '(no stderr)';
    return {
      ok: false,
      detail: `security find-generic-password failed (exit ${r.exitCode}): ${err}`,
    };
  }
  try {
    JSON.parse(blob);
  } catch {
    return { ok: false, detail: 'Keychain blob is not valid JSON — unexpected item shape' };
  }
  mkdirSync(dirname(credsFile), { recursive: true });
  const tmp = `${credsFile}.tmp`;
  writeFileSync(tmp, `${blob}\n`);
  chmodSync(tmp, 0o600);
  renameSync(tmp, credsFile);
  return { ok: true, detail: `wrote ${credsFile}` };
}

export interface PlistOptions {
  label: string;
  intervalSeconds: number;
  logPath: string;
}

/**
 * Build the launchd UserAgent plist. The plist is intentionally
 * dependency-free — it shells `security` + `mv` + `chmod` directly, so
 * uninstalling arbiter or upgrading Bun never breaks the refresh.
 *
 * The bash one-liner is built to be safe to run unattended:
 *  - `set -e` so any failed step aborts (no partial writes propagated).
 *  - Write to a tmp file, chmod 600, then atomic rename. Same shape as
 *    {@link exportKeychainToFile}.
 *  - Quoted `$HOME` so paths with spaces don't blow up.
 */
export function buildLaunchAgentPlist(opts: PlistOptions): string {
  const cmd = [
    'set -e',
    'mkdir -p "$HOME/.claude"',
    'tmp="$HOME/.claude/.credentials.json.tmp"',
    `security find-generic-password -s '${KEYCHAIN_SERVICE}' -w > "$tmp"`,
    'chmod 600 "$tmp"',
    'mv "$tmp" "$HOME/.claude/.credentials.json"',
  ].join('; ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${cmd}</string>
  </array>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${opts.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${opts.logPath}</string>
</dict>
</plist>
`;
}

export function plistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

function runLaunchctl(args: string[]): { ok: boolean; stderr: string } {
  const r = Bun.spawnSync(['launchctl', ...args]);
  return { ok: r.exitCode === 0, stderr: r.stderr?.toString().trim() ?? '' };
}

export function installLaunchAgent(home: string = homedir()): ExportResult {
  if (platform() !== 'darwin') {
    return { ok: false, detail: `not macOS (platform=${platform()})` };
  }
  const path = plistPath(home);
  const body = buildLaunchAgentPlist({
    label: AGENT_LABEL,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    logPath: '/tmp/arbiter-creds-refresh.log',
  });
  mkdirSync(dirname(path), { recursive: true });
  // Idempotent: unload-then-load. `unload` errors when nothing is loaded,
  // which is fine; we ignore the result. `load -w` registers and starts.
  runLaunchctl(['unload', path]);
  writeFileSync(path, body);
  const loaded = runLaunchctl(['load', '-w', path]);
  if (!loaded.ok) {
    return { ok: false, detail: `launchctl load failed: ${loaded.stderr || '(no stderr)'}` };
  }
  return { ok: true, detail: `installed launchd agent at ${path} (every ${DEFAULT_INTERVAL_SECONDS}s)` };
}

export function uninstallLaunchAgent(home: string = homedir()): ExportResult {
  if (platform() !== 'darwin') {
    return { ok: false, detail: `not macOS (platform=${platform()})` };
  }
  const path = plistPath(home);
  if (!existsSync(path)) {
    return { ok: true, detail: `no agent installed at ${path}` };
  }
  runLaunchctl(['unload', path]);
  rmSync(path, { force: true });
  return { ok: true, detail: `removed launchd agent at ${path}` };
}

function parseArgs(argv: string[]): {
  mode: 'once' | 'watch' | 'install' | 'uninstall';
  intervalSeconds: number;
} {
  let mode: 'once' | 'watch' | 'install' | 'uninstall' = 'once';
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--watch') {
      mode = 'watch';
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        intervalSeconds = parseInt(next, 10);
        i++;
      }
    } else if (a === '--once') mode = 'once';
    else if (a === '--install-agent') mode = 'install';
    else if (a === '--uninstall-agent') mode = 'uninstall';
  }
  return { mode, intervalSeconds };
}

async function main(): Promise<void> {
  const { mode, intervalSeconds } = parseArgs(process.argv.slice(2));

  if (mode === 'install') {
    const r = installLaunchAgent();
    console.log(r.ok ? `  ✓ ${r.detail}` : `  ! ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (mode === 'uninstall') {
    const r = uninstallLaunchAgent();
    console.log(r.ok ? `  ✓ ${r.detail}` : `  ! ${r.detail}`);
    process.exit(r.ok ? 0 : 1);
  }

  const once = (): boolean => {
    const r = exportKeychainToFile();
    const stamp = new Date().toISOString();
    console.log(r.ok ? `[${stamp}] ${r.detail}` : `[${stamp}] FAILED: ${r.detail}`);
    return r.ok;
  };

  if (mode === 'once') {
    process.exit(once() ? 0 : 1);
  }

  // watch: refresh forever. We deliberately keep going on failure (e.g.
  // a transient Keychain prompt) so the loop self-heals on the next tick
  // rather than dying and leaving the file to drift.
  console.log(`refresh-creds: watching, interval=${intervalSeconds}s`);
  once();
  setInterval(once, intervalSeconds * 1000);
  // Keep alive forever.
  await new Promise(() => {});
}

if (import.meta.main) await main();
