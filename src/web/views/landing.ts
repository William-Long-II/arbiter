/**
 * Signed-out landing. Standalone HTML (no Layout) because Layout assumes an
 * authenticated user for the top-nav. Inline CSS so the page works on the
 * very first request before any static asset has loaded. Kept as a plain
 * string (not JSX) for the same reason — zero dependencies on the render
 * pipeline. Tokens mirror DESIGN.md.
 */
export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>arbiter</title>
  <style>
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
    }
    * { box-sizing: border-box; }
    body {
      background: var(--canvas); color: var(--ink); margin: 0;
      font-family: Inter, -apple-system, system-ui, sans-serif;
      font-size: 14px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 720px; padding: 96px 24px 64px; margin: 0 auto;
      min-height: 100vh; display: flex; flex-direction: column;
    }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 64px; }
    .mark { color: var(--primary); font-size: 16px; }
    .wordmark { font-size: 18px; font-weight: 600; letter-spacing: -0.2px; }
    h1 {
      font-size: 40px; font-weight: 600; letter-spacing: -0.8px; line-height: 1.1;
      margin: 0 0 16px;
    }
    .tagline {
      color: var(--ink-muted); font-size: 17px; line-height: 1.5;
      max-width: 560px; margin: 0 0 32px;
    }
    .cta {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--primary); color: var(--on-primary);
      padding: 10px 18px; height: 40px;
      border-radius: 8px;
      font-size: 14px; font-weight: 500;
      text-decoration: none;
      transition: background 120ms ease;
    }
    .cta:hover { background: var(--primary-hover); color: var(--on-primary); }
    .bullets {
      display: grid; grid-template-columns: 1fr; gap: 16px;
      margin: 64px 0 0; padding: 0; list-style: none;
    }
    @media (min-width: 720px) { .bullets { grid-template-columns: repeat(3, 1fr); } }
    .bullet {
      background: var(--surface-1);
      border: 1px solid var(--hairline);
      border-radius: 12px; padding: 20px;
    }
    .bullet h3 {
      margin: 0 0 6px; font-size: 14px; font-weight: 500; color: var(--ink);
    }
    .bullet p {
      margin: 0; color: var(--ink-subtle); font-size: 13px; line-height: 1.5;
    }
    footer {
      margin-top: auto; padding-top: 48px;
      color: var(--ink-subtle); font-size: 12px;
    }
    code {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      color: var(--ink-muted); font-size: 12px;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { color: var(--primary-hover); }
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <span class="mark" aria-hidden="true">◆</span>
      <span class="wordmark">arbiter</span>
    </header>

    <h1>Automated PR reviews,<br/>on your terms.</h1>
    <p class="tagline">
      arbiter watches the pull requests in repos and orgs you choose, runs them
      through Claude, and posts a structured review back. Self-hosted, your
      GitHub access, your subscription.
    </p>

    <a class="cta" href="/auth/github">Sign in with GitHub →</a>

    <ul class="bullets">
      <li class="bullet">
        <h3>Scope rules</h3>
        <p>
          Pick the repos or orgs you want covered, plus branch patterns.
          Skip your own PRs and bot authors automatically.
        </p>
      </li>
      <li class="bullet">
        <h3>Three scrutiny tiers</h3>
        <p>
          Light, standard, or strict — pick per scope. Strict pairs well with
          protected branches like <code>main</code> or <code>release/*</code>.
        </p>
      </li>
      <li class="bullet">
        <h3>Optional auto-approve</h3>
        <p>
          When the reviewer's verdict has no blockers, post as an actual
          <code>APPROVE</code>. Opt-in per scope.
        </p>
      </li>
    </ul>

    <footer>
      Health: <code>GET /healthz</code> · Source: self-hosted arbiter
    </footer>
  </main>
</body>
</html>`;
}
