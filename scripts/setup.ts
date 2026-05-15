#!/usr/bin/env bun
/**
 * Host-side, one-command setup for subscription-mode Docker.
 *
 * Run on the HOST (not in the container): `bun run setup`. It wires up
 * the OS-specific credential plumbing that the bind-mount needs so
 * `claude -p` works inside the container:
 *
 *   - Windows: $HOME is unset under PowerShell, so the compose mount
 *              defaults to an empty dir. We pin CLAUDE_HOST_DIR in .env.
 *   - macOS:   Claude Code stores creds in the Keychain, not a file.
 *              We export the blob to ~/.claude/.credentials.json so the
 *              (Linux) container can read it.
 *   - Linux:   the default mount already works; we just sanity-check.
 *
 * Idempotent: safe to re-run (e.g. after a macOS token expiry).
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const ENV_PATH = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace `KEY=...` in place if present, else append it. Preserves all
 * other lines (including secrets) and trailing-newline shape. Pure so it
 * can be unit-tested without touching disk.
 */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}${line}\n`;
}

/** Read a KEY=value from raw .env content (last wins), trimmed. */
export function readEnvValue(content: string, key: string): string | undefined {
  const re = new RegExp(`^${escapeRegExp(key)}=(.*)$`, 'mg');
  let m: RegExpExecArray | null;
  let last: string | undefined;
  while ((m = re.exec(content)) !== null) last = m[1];
  return last?.trim();
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ! ${msg}`);
}
function info(msg: string): void {
  console.log(`  • ${msg}`);
}

function ensureEnvFile(): string {
  if (!existsSync(ENV_PATH)) {
    if (!existsSync(ENV_EXAMPLE)) {
      console.error('No .env and no .env.example to seed from — aborting.');
      process.exit(1);
    }
    copyFileSync(ENV_EXAMPLE, ENV_PATH);
    ok('created .env from .env.example');
  }
  return readFileSync(ENV_PATH, 'utf8');
}

function validateCredsFile(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  console.log('arbiter setup — subscription-mode Docker credentials\n');

  let env = ensureEnvFile();
  const mode = readEnvValue(env, 'CLAUDE_DEFAULT_MODE') || 'subscription';

  if (mode === 'api') {
    const key = readEnvValue(env, 'ANTHROPIC_API_KEY');
    if (key) ok('api mode: ANTHROPIC_API_KEY is set — nothing else to wire.');
    else warn('api mode but ANTHROPIC_API_KEY is empty in .env — set it before starting.');
    console.log('\nDone.');
    return;
  }

  const host = platform();
  console.log(`Mode: subscription. Host OS: ${host}\n`);

  // Native FS path (for existence checks) vs the forward-slash form
  // Docker Desktop wants in the bind-mount source.
  const fsClaudeDir = join(homedir(), '.claude');
  const credsFile = join(fsClaudeDir, '.credentials.json');

  if (host === 'win32') {
    const dockerDir = fsClaudeDir.replace(/\\/g, '/');
    env = upsertEnvLine(env, 'CLAUDE_HOST_DIR', dockerDir);
    writeFileSync(ENV_PATH, env);
    ok(`pinned CLAUDE_HOST_DIR=${dockerDir} in .env`);
    if (!validateCredsFile(credsFile)) {
      warn(`no valid creds at ${credsFile}`);
      info('Run `claude` on the host and complete login, then re-run setup.');
    } else {
      ok('found valid Claude credentials on the host.');
    }
  } else if (host === 'darwin') {
    if (validateCredsFile(credsFile)) {
      ok(`found valid creds at ${credsFile} (Keychain export already done).`);
    } else {
      info('macOS keeps creds in the Keychain — exporting to a file the container can read…');
      const r = Bun.spawnSync(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']);
      const blob = r.stdout?.toString() ?? '';
      if (r.exitCode === 0 && blob.trim()) {
        mkdirSync(dirname(credsFile), { recursive: true });
        writeFileSync(credsFile, blob.endsWith('\n') ? blob : `${blob}\n`);
        chmodSync(credsFile, 0o600);
        if (validateCredsFile(credsFile)) {
          ok(`exported Keychain creds to ${credsFile} (chmod 600).`);
          info('Note: this is a snapshot. The container refreshes its own copy');
          info('independently of the host Keychain. If container reviews start');
          info('timing out weeks later, just re-run `bun run setup` to reseed.');
        } else {
          warn('exported blob is not valid JSON — Keychain item may be unexpected.');
        }
      } else {
        warn('could not read the Keychain item `Claude Code-credentials`.');
        info('Run `claude` on the host and complete login, then re-run setup.');
      }
    }
    // $HOME is set on macOS, so the default compose mount resolves; no
    // CLAUDE_HOST_DIR needed.
  } else {
    if (validateCredsFile(credsFile)) {
      ok(`found valid creds at ${credsFile}; default mount works as-is.`);
    } else {
      warn(`no valid creds at ${credsFile}`);
      info('Run `claude` on the host and complete login, then re-run setup.');
    }
  }

  console.log('\nNext:');
  console.log('  docker compose up -d --force-recreate app');
  console.log('  docker compose exec app claude -p "hi"   # should reply, not hang');
}

if (import.meta.main) main();
