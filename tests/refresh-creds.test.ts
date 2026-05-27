import { describe, expect, test } from 'bun:test';
import { platform } from 'node:os';
import {
  AGENT_LABEL,
  DEFAULT_INTERVAL_SECONDS,
  buildLaunchAgentPlist,
  exportKeychainToFile,
  installLaunchAgent,
  plistPath,
  uninstallLaunchAgent,
} from '../scripts/refresh-creds.ts';

describe('buildLaunchAgentPlist', () => {
  const plist = buildLaunchAgentPlist({
    label: AGENT_LABEL,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    logPath: '/tmp/arbiter-creds-refresh.log',
  });

  test('declares the expected label and interval', () => {
    expect(plist).toContain(`<string>${AGENT_LABEL}</string>`);
    expect(plist).toContain(`<integer>${DEFAULT_INTERVAL_SECONDS}</integer>`);
  });

  test('runs once at load so the file is fresh immediately, not on the next StartInterval tick', () => {
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test('writes via a tmp file + atomic rename — a crashed export must never leave a half-written .credentials.json', () => {
    expect(plist).toContain('.credentials.json.tmp');
    expect(plist).toContain('mv "$tmp" "$HOME/.claude/.credentials.json"');
    // chmod must happen on the tmp before the rename so the final file
    // never exists with looser perms, even briefly.
    const tmpIdx = plist.indexOf('chmod 600 "$tmp"');
    const mvIdx = plist.indexOf('mv "$tmp"');
    expect(tmpIdx).toBeGreaterThan(-1);
    expect(mvIdx).toBeGreaterThan(tmpIdx);
  });

  test('uses set -e so a Keychain miss aborts before clobbering the live file with an empty tmp', () => {
    expect(plist).toContain('set -e');
  });

  test('quotes $HOME so paths with spaces (common on macOS) work', () => {
    expect(plist).toContain('"$HOME/.claude"');
  });

  test('targets the correct Keychain service name', () => {
    expect(plist).toContain("security find-generic-password -s 'Claude Code-credentials' -w");
  });

  test('points stdout/stderr at the documented log path', () => {
    expect(plist).toMatch(/<key>StandardOutPath<\/key>\s*<string>\/tmp\/arbiter-creds-refresh\.log<\/string>/);
    expect(plist).toMatch(/<key>StandardErrorPath<\/key>\s*<string>\/tmp\/arbiter-creds-refresh\.log<\/string>/);
  });
});

describe('plistPath', () => {
  test('lands under the user LaunchAgents dir, not LaunchDaemons (we are not root)', () => {
    // Use a sep-agnostic check so this runs the same on CI Linux and a
    // dev macOS host. The function is only ever called on macOS in
    // practice, but the test suite runs cross-platform.
    const p = plistPath('/Users/test').replace(/\\/g, '/');
    expect(p).toBe(`/Users/test/Library/LaunchAgents/${AGENT_LABEL}.plist`);
  });
});

describe('non-darwin guards', () => {
  // The agent install/uninstall paths shell out to launchctl, which only
  // exists on macOS. We must short-circuit cleanly on Windows/Linux
  // instead of throwing — setup.ts on those platforms never enters this
  // branch, but ad-hoc CLI invocations should still fail loud.
  const isDarwin = platform() === 'darwin';

  test.skipIf(isDarwin)('exportKeychainToFile refuses to run', () => {
    const r = exportKeychainToFile();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not macOS');
  });

  test.skipIf(isDarwin)('installLaunchAgent refuses to run', () => {
    const r = installLaunchAgent();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not macOS');
  });

  test.skipIf(isDarwin)('uninstallLaunchAgent refuses to run', () => {
    const r = uninstallLaunchAgent();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not macOS');
  });
});
