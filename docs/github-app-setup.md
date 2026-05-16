# GitHub App setup (OAuth → App migration)

Authoritative operator guide for registering and wiring the arbiter GitHub
App. This is the keystone migration: it replaces the broad-scoped OAuth
**user** token stored unencrypted at rest with (a) short-lived,
auto-refreshing, App-scoped **user-to-server** tokens for actions that
post *as you*, and (b) short-lived **installation** tokens for read /
checkout. Reviews still appear under **your** identity — not a bot.

> **Status:** the App support ships in slices. Slices 1–2 (credential
> core, installation registry, resolver) are inert until configured;
> **slice 3** adds App user-login + token refresh; **slice 4** flips the
> review path over. You can register the App now; it is fully exercised
> once slice 4 lands. Nothing here breaks the existing OAuth login until
> you switch.

---

## Two distinct credentials (don't conflate)

The GitHub App uses **two** credential pairs, both different from the
legacy OAuth App's `GITHUB_CLIENT_ID/SECRET`:

| Purpose | Credential | Env |
|---|---|---|
| Mint **installation** tokens (read/checkout) | App ID + **private key** (PEM) | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` |
| **User** login + post-as-you (user-to-server) | App **client ID** + **client secret** | `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` |

The legacy OAuth App (`github.com/settings/developers`,
`GITHUB_CLIENT_ID/SECRET`) becomes **obsolete** once slice 4 lands;
existing users re-authenticate once (their old broad token is replaced by
an App-scoped, refreshing one).

---

## The webhook URL

The only URL that must be publicly reachable is the **Webhook URL** —
GitHub's servers POST to it, so `localhost` does not work.

- **Deployed:** `https://<your-domain>/api/webhooks/github`; set
  `PUBLIC_URL=https://<your-domain>`.
- **Local testing:** tunnel it — smee.io (GitHub's recommended dev
  approach), `cloudflared tunnel --url http://localhost:8787`, or
  `ngrok http 8787`. Webhook URL = `https://<tunnel-host>/api/webhooks/github`.
  Set `PUBLIC_URL` to the tunnel too so commit-status / review links
  resolve.

---

## Register the App

`github.com/settings/apps` → **New GitHub App**.

- **GitHub App name:** `arbiter-<yourname>` (globally unique).
- **Description:** *Automated PR review queue — reviews pull requests
  with Claude and posts a structured review, optional inline comments,
  and an opt-in merge gate. Uses short-lived per-installation and
  refreshing user tokens — no broad token stored at rest.*
- **Homepage URL:** any valid URL (e.g. the repo URL).

### Identifying and authorizing users

- **Callback URL:** `<PUBLIC_URL>/auth/github/callback` — **required**.
- **Expire user authorization tokens:** **✅ ENABLED.** This is what
  issues refresh tokens; with it off, user tokens never expire and the
  whole security benefit is lost.
- **Request user authorization (OAuth) during installation:** ✅
  recommended (installing the App also logs you in — smoother self-host).
- **Enable Device Flow:** unchecked.

### Post installation

- **Setup URL:** blank. **Redirect on update:** unchecked.

### Webhook

- **Active:** ✅
- **Webhook URL:** see above.
- **Secret:** the **same value** as `GITHUB_WEBHOOK_SECRET`. None yet?
  `openssl rand -hex 32`, set it here and in `.env`.
- **SSL verification:** ✅ Enable.

### Repository permissions (all others: No access)

| Permission | Access | Why |
|---|---|---|
| Pull requests | **Read & write** | Post review + inline comments |
| Contents | **Read-only** | Shallow-checkout the PR head |
| Commit statuses | **Read & write** | Opt-in blocking-gate status |
| Checks | **Read-only** | CI signal summary |
| Metadata | **Read-only** | Mandatory baseline |

### Subscribe to events

- ✅ **Pull request** (the only checkbox needed).
- `installation` / `installation_repositories` are delivered to a GitHub
  App automatically — there is no checkbox, and arbiter already handles
  them. Don't look for an "Installation" event option.

### Where can this GitHub App be installed?

- **Only on this account** (self-host). Switch to "Any account" later for
  multi-org.

---

## After creation

1. **Private key:** App → *Private keys* → **Generate**; download the
   `.pem`.
2. **Client secret:** App → *Client secrets* → **Generate**. Note the
   **Client ID** (shown on the App page) and the secret.
3. **`.env`:**
   ```
   GITHUB_APP_ID=<app id>
   GITHUB_APP_PRIVATE_KEY=<PEM with literal \n, or base64 of the .pem>
   GITHUB_APP_CLIENT_ID=<Iv… client id>
   GITHUB_APP_CLIENT_SECRET=<client secret>
   GITHUB_WEBHOOK_SECRET=<same as the App's webhook secret>
   PUBLIC_URL=<public/tunnel base URL>
   ```
   (`GITHUB_APP_PRIVATE_KEY` accepts a PEM with literal `\n` or a
   base64-encoded whole PEM — both are normalized.)
4. Restart: `docker compose up -d --force-recreate app`. Migrations run
   automatically on boot (Postgres must be reachable).
5. **Install** the App on your account/org and the repos to review. The
   `installation` webhook fires → registry row created (verify:
   `[webhook] installation upsert` log / `SELECT * FROM app_installations`).
6. **Re-authenticate** once via the App (login replaces the legacy broad
   token with the App-scoped refreshing one).

## End-to-end test (after slice 4)

Open or push a PR in an installed repo → a review runs. Confirm:

- the review is posted under **your** GitHub identity (not a bot);
- logs show read/checkout using an installation token and posting using
  the refreshed user token;
- the legacy `GITHUB_CLIENT_ID/SECRET` can be removed and login still
  works through the App.
