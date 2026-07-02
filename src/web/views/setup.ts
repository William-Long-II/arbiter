/**
 * First-run setup wizard pages. Standalone HTML (no Layout) for the same
 * reasons as the landing page: there is no authenticated user yet — in
 * fact there is no OAuth app to authenticate *with* yet — and the page
 * must work on the very first request. Tokens mirror DESIGN.md.
 */

const SHELL_CSS = `
    :root {
      --canvas: #010102;
      --surface-1: #0f1011;
      --hairline: #23252a;
      --ink: #f7f8f8;
      --ink-muted: #d0d6e0;
      --ink-subtle: #8a8f98;
      --primary: #cc785c;
      --primary-hover: #d68b6f;
      --on-primary: #fff;
      --danger: #e5484d;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--canvas); color: var(--ink); margin: 0;
      font-family: Inter, -apple-system, system-ui, sans-serif;
      font-size: 14px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 560px; padding: 72px 24px 64px; margin: 0 auto; }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 40px; }
    .mark { color: var(--primary); font-size: 16px; }
    .wordmark { font-size: 18px; font-weight: 600; letter-spacing: -0.2px; }
    h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.4px; margin: 0 0 8px; }
    .sub { color: var(--ink-muted); margin: 0 0 32px; }
    .card {
      background: var(--surface-1); border: 1px solid var(--hairline);
      border-radius: 12px; padding: 24px; margin-bottom: 20px;
    }
    .card h2 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
    .card .hint { color: var(--ink-subtle); font-size: 13px; margin: 0 0 16px; }
    label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 6px; }
    label:first-of-type { margin-top: 0; }
    .optional { color: var(--ink-subtle); font-weight: 400; }
    input[type="text"], input[type="password"] {
      width: 100%; padding: 9px 12px;
      background: var(--canvas); color: var(--ink);
      border: 1px solid var(--hairline); border-radius: 8px;
      font-size: 14px; font-family: inherit;
    }
    input:focus { outline: none; border-color: var(--primary); }
    button {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--primary); color: var(--on-primary);
      border: none; cursor: pointer;
      padding: 10px 18px; height: 40px; border-radius: 8px;
      font-size: 14px; font-weight: 500; font-family: inherit;
    }
    button:hover { background: var(--primary-hover); }
    .errors {
      background: color-mix(in srgb, var(--danger) 12%, transparent);
      border: 1px solid var(--danger); border-radius: 8px;
      padding: 12px 16px; margin: 0 0 20px;
      color: var(--ink); font-size: 13px;
    }
    .errors ul { margin: 0; padding-left: 18px; }
    code {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      color: var(--ink-muted); font-size: 12px;
      background: var(--canvas); border: 1px solid var(--hairline);
      border-radius: 4px; padding: 1px 5px;
      overflow-wrap: anywhere;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { color: var(--primary-hover); }
    .note { color: var(--ink-subtle); font-size: 12px; margin-top: 8px; }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · arbiter</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <main class="wrap">
    <header>
      <span class="mark" aria-hidden="true">◆</span>
      <span class="wordmark">arbiter</span>
    </header>
${body}
  </main>
</body>
</html>`;
}

export function setupCodePage(error?: string): string {
  return shell('Setup', `
    <h1>First-run setup</h1>
    <p class="sub">
      This instance isn't configured yet. Enter the one-time setup code
      from the server logs (<code>docker compose logs app</code>) to continue.
    </p>
    ${error ? `<div class="errors">${esc(error)}</div>` : ''}
    <form method="post" action="/setup/code" class="card">
      <label for="code">Setup code</label>
      <input type="text" id="code" name="code" autocomplete="off" autofocus
             placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <p class="note">The code changes on every restart of the app container.</p>
      <p style="margin:16px 0 0"><button type="submit">Continue →</button></p>
    </form>
  `);
}

export interface SetupWizardValues {
  githubClientId: string;
  githubClientSecret: string;
  claudeToken: string;
  webhookSecret: string;
}

export function setupWizardPage(opts: {
  publicUrl: string;
  values?: Partial<SetupWizardValues>;
  errors?: string[];
  claudeTokenRequired: boolean;
}): string {
  const v = opts.values ?? {};
  const callbackUrl = `${opts.publicUrl}/auth/github/callback`;
  const webhookUrl = `${opts.publicUrl}/api/webhooks/github`;
  const errors = opts.errors ?? [];
  return shell('Setup', `
    <h1>Configure this instance</h1>
    <p class="sub">
      Three things and you're live. Everything here is stored in this
      instance's database — nothing leaves the server.
    </p>
    ${errors.length > 0
      ? `<div class="errors"><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
      : ''}
    <form method="post" action="/setup">
      <div class="card">
        <h2>1 · GitHub OAuth app</h2>
        <p class="hint">
          Create one at <a href="https://github.com/settings/developers"
          target="_blank" rel="noopener">github.com/settings/developers</a>
          → “New OAuth App”. Set the authorization callback URL to
          <code>${esc(callbackUrl)}</code>, then paste the credentials here.
        </p>
        <label for="github_client_id">Client ID</label>
        <input type="text" id="github_client_id" name="github_client_id"
               autocomplete="off" value="${esc(v.githubClientId ?? '')}" />
        <label for="github_client_secret">Client secret</label>
        <input type="password" id="github_client_secret" name="github_client_secret"
               autocomplete="off" value="${esc(v.githubClientSecret ?? '')}" />
      </div>

      <div class="card">
        <h2>2 · Claude subscription token${opts.claudeTokenRequired ? '' : ' <span class="optional">(already provided by the server)</span>'}</h2>
        <p class="hint">
          On any machine where you're logged into Claude Code, run
          <code>claude setup-token</code> and paste the
          <code>sk-ant-oat…</code> token it prints. Reviews run on this
          subscription. The token is checked live before it's saved.
        </p>
        <label for="claude_code_oauth_token">Token</label>
        <input type="password" id="claude_code_oauth_token" name="claude_code_oauth_token"
               autocomplete="off" value="${esc(v.claudeToken ?? '')}" />
      </div>

      <div class="card">
        <h2>3 · Webhook secret <span class="optional">(optional)</span></h2>
        <p class="hint">
          Any random string. Add a webhook on the repos/orgs you review —
          payload URL <code>${esc(webhookUrl)}</code>, content type
          <code>application/json</code>, event “Pull requests” — with this
          same secret for near-instant reviews. Leave blank to rely on
          polling only.
        </p>
        <label for="github_webhook_secret">Secret</label>
        <input type="password" id="github_webhook_secret" name="github_webhook_secret"
               autocomplete="off" value="${esc(v.webhookSecret ?? '')}" />
      </div>

      <button type="submit">Validate &amp; finish setup</button>
      <p class="note">
        Finishing validates the Claude token with a real
        <code>claude&nbsp;-p</code> call — allow up to 30 seconds.
      </p>
    </form>
  `);
}

export function setupDonePage(): string {
  return shell('Setup complete', `
    <h1>Setup complete ✓</h1>
    <p class="sub">
      This instance is configured. Sign in with GitHub to define which
      repos and branches get reviewed.
    </p>
    <p><a href="/auth/github"><button type="button">Sign in with GitHub →</button></a></p>
  `);
}
