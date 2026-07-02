/**
 * First-run setup wizard: routes + gate.
 *
 * A fresh instance has no GitHub OAuth app configured, so there is nothing
 * to sign in with — the wizard is instead gated by a one-time code printed
 * to the server logs at boot (proof of operator access). Entering it grants
 * a short-lived signed cookie; the wizard form then collects GitHub OAuth
 * credentials, a Claude subscription token (live-validated with a real
 * `claude -p` call before anything is saved), and an optional webhook
 * secret. All values land in app_settings; consumers read them through
 * src/settings.ts effective getters, so the instance is fully usable the
 * moment setup completes — no restart.
 */

import type { Context, Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { sign, verify } from './cookies.ts';
import {
  getSetupCode,
  markSetupComplete,
  saveAppSettings,
  setupNeeded,
  verifySetupCode,
} from '../settings.ts';
import { preflightClaudeCli } from '../review/runner.ts';
import {
  setupCodePage,
  setupDonePage,
  setupWizardPage,
  type SetupWizardValues,
} from './views/setup.ts';

export const SETUP_COOKIE = 'rm_setup';
const SETUP_COOKIE_TTL_SECONDS = 60 * 30;

const isProd = process.env.NODE_ENV === 'production';

/**
 * While setup is pending, everything routes to the wizard. Exemptions:
 * the wizard itself, health/metrics probes, static assets, and the
 * webhook receiver (which self-disables without a secret anyway, and
 * must never redirect — GitHub would record the 302 as a delivery
 * failure with a misleading shape).
 */
export const setupGate: MiddlewareHandler = async (c, next) => {
  if (!setupNeeded()) return next();
  const p = c.req.path;
  if (
    p.startsWith('/setup') ||
    p.startsWith('/static') ||
    p === '/healthz' ||
    p === '/metrics' ||
    p === '/api/webhooks/github'
  ) {
    return next();
  }
  return c.redirect('/setup');
};

/** Is the Claude token a required wizard field on this instance? Not when
 *  the operator already provided credentials via the environment. */
export function claudeTokenRequired(): boolean {
  if (config.claude.defaultMode === 'api' && config.claude.apiKey) return false;
  return !process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

export interface SetupFormResult {
  ok: boolean;
  errors: string[];
  values: SetupWizardValues;
}

/** Pure form validation — exported for tests. */
export function parseSetupForm(
  form: Record<string, string>,
  opts: { claudeTokenRequired: boolean },
): SetupFormResult {
  const values: SetupWizardValues = {
    githubClientId: (form.github_client_id ?? '').trim(),
    githubClientSecret: (form.github_client_secret ?? '').trim(),
    claudeToken: (form.claude_code_oauth_token ?? '').trim(),
    webhookSecret: (form.github_webhook_secret ?? '').trim(),
  };
  const errors: string[] = [];
  if (!values.githubClientId) {
    errors.push('GitHub client ID is required.');
  } else if (/\s/.test(values.githubClientId)) {
    errors.push('GitHub client ID must not contain whitespace.');
  }
  if (!values.githubClientSecret) {
    errors.push('GitHub client secret is required.');
  } else if (/\s/.test(values.githubClientSecret)) {
    errors.push('GitHub client secret must not contain whitespace.');
  }
  if (!values.claudeToken && opts.claudeTokenRequired) {
    errors.push('Claude subscription token is required — run `claude setup-token` to get one.');
  }
  if (values.claudeToken && !/^sk-ant-[A-Za-z0-9_-]{8,}$/.test(values.claudeToken)) {
    errors.push('Claude token does not look like a `claude setup-token` value (expected sk-ant-oat…).');
  }
  return { ok: errors.length === 0, errors, values };
}

export function mountSetup(app: Hono): void {
  app.get('/setup', async (c) => {
    if (!setupNeeded()) return c.redirect('/');
    if (!(await hasSetupGrant(c))) return c.html(setupCodePage());
    return c.html(
      setupWizardPage({
        publicUrl: config.publicUrl,
        claudeTokenRequired: claudeTokenRequired(),
      }),
    );
  });

  app.post('/setup/code', async (c) => {
    if (!setupNeeded()) return c.redirect('/');
    const form = await readFormStrings(c);
    const code = (form.code ?? '').trim();
    if (!code || !verifySetupCode(code)) {
      return c.html(setupCodePage('That code didn’t match. It’s printed in the app container logs and changes on every restart.'), 401);
    }
    setCookie(c, SETUP_COOKIE, await sign(`setup:${getSetupCode()}`), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProd,
      path: '/',
      maxAge: SETUP_COOKIE_TTL_SECONDS,
    });
    return c.redirect('/setup');
  });

  app.post('/setup', async (c) => {
    if (!setupNeeded()) return c.redirect('/');
    if (!(await hasSetupGrant(c))) return c.html(setupCodePage('Enter the setup code first.'), 403);

    const tokenRequired = claudeTokenRequired();
    const form = await readFormStrings(c);
    const parsed = parseSetupForm(form, { claudeTokenRequired: tokenRequired });

    const rerender = (errors: string[], status: 400 | 502) =>
      c.html(
        setupWizardPage({
          publicUrl: config.publicUrl,
          values: parsed.values,
          errors,
          claudeTokenRequired: tokenRequired,
        }),
        status,
      );

    if (!parsed.ok) return rerender(parsed.errors, 400);

    // Live-validate the token before persisting anything: a typo'd token
    // discovered here costs one page reload; discovered at review time it
    // costs a silent broken instance.
    if (parsed.values.claudeToken) {
      const pre = await preflightClaudeCli(parsed.values.claudeToken);
      if (!pre.ok) {
        return rerender([`Claude token validation failed: ${pre.detail}`], 502);
      }
    }

    await saveAppSettings({
      github_client_id: parsed.values.githubClientId,
      github_client_secret: parsed.values.githubClientSecret,
      claude_code_oauth_token: parsed.values.claudeToken,
      github_webhook_secret: parsed.values.webhookSecret,
    });
    await markSetupComplete();
    console.log('[setup] first-run setup completed via wizard');
    return c.html(setupDonePage());
  });
}

async function hasSetupGrant(c: Context): Promise<boolean> {
  const signed = getCookie(c, SETUP_COOKIE);
  if (!signed) return false;
  const value = await verify(signed);
  return value === `setup:${getSetupCode()}`;
}

async function readFormStrings(c: Context): Promise<Record<string, string>> {
  const data = await c.req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of data.entries()) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
