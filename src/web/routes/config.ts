import type { Store } from "../../state/db.ts";
import type { Config, FieldError } from "../../config.ts";
import { validateConfig } from "../../config.ts";
import { sluggedPath } from "../../github/slug.ts";
import { currentActor, diffGeneralConfig, recordAudit } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout, type Banner, type SessionUser } from "../layout.ts";

/**
 * Runtime status of the webhook ingest path. Passed in from the server
 * layer because the config handler doesn't otherwise see process.env.
 * When `configured` is false, /webhook/github responds 503 and the UI
 * should make it clear why.
 */
export type WebhookStatus = { configured: boolean };

export function configRoute(args: {
  store: Store;
  cfg: Config;
  banner?: Banner | null;
  /**
   * Validation errors from a failed save. When present the form re-renders
   * with `cfg` = the user's submitted candidate (not the persisted values),
   * plus an error banner so they can fix and resubmit without retyping.
   */
  errors?: FieldError[];
  /** Webhook status passed through from the server; optional for backward-compat tests. */
  webhook?: WebhookStatus;
  user?: SessionUser | null;
}): Response {
  const { store, cfg, errors, webhook, user } = args;
  const orgs = store.listOrgs();
  const repos = store.listWatchedRepoRows();
  const toneTemplates = store.listToneTemplates();
  // When rendering a failed save, skip_authors comes from the submitted
  // cfg (so the user keeps their edits). On a fresh GET we read from DB.
  const skipAuthors = errors && errors.length > 0
    ? cfg.github.skip_authors
    : store.listSkipAuthors();

  const errorBanner: Banner | null =
    errors && errors.length > 0
      ? {
          kind: "err",
          message:
            "Couldn't save — fix the following and try again: " +
            errors.map((e) => `${e.path} (${e.message})`).join("; "),
        }
      : null;

  const body = html`
    <section class="card">
      <h2>General</h2>
      <form method="post" action="/config/general">
        <label>Bot GitHub username (the account whose PAT posts reviews)</label>
        <input type="text" name="bot_username" value="${cfg.github.bot_username}" placeholder="my-review-bot" required>

        <label title="When set alongside GITHUB_OAUTH_CLIENT_SECRET env, switches from basic auth to session-based GitHub login. Leave empty to keep basic auth.">GitHub OAuth App client id (optional)</label>
        <input type="text" name="oauth_client_id" value="${cfg.github.oauth_client_id}" placeholder="Iv23li0... (leave empty for basic auth)">

        <label>Skip authors (one per line) — PRs by these users are ignored</label>
        <textarea name="skip_authors" placeholder="your-github-login&#10;teammate-to-skip">${skipAuthors.join("\n")}</textarea>

        <label>Review tone</label>
        <textarea name="tone">${cfg.review.tone}</textarea>

        <label title="Glob patterns. One per line. If non-empty, ONLY files matching at least one pattern are reviewed. Leave empty to review everything the excludes don't drop.">Include paths (one glob per line, empty = review everything)</label>
        <textarea name="include_paths" placeholder="src/**&#10;packages/*/src/**">${cfg.review.include_paths.join("\n")}</textarea>

        <label title="Glob patterns. Any match drops the file after include. Seeded on first boot with common lockfiles and generated-code patterns.">Exclude paths (one glob per line)</label>
        <textarea name="exclude_paths" placeholder="**/*.lock&#10;**/node_modules/**&#10;**/dist/**">${cfg.review.exclude_paths.join("\n")}</textarea>

        <div class="grid space">
          <div>
            <label>Dry run</label>
            <select name="dry_run">
              <option value="true" ${cfg.review.dry_run ? "selected" : ""}>true (compute + log only)</option>
              <option value="false" ${!cfg.review.dry_run ? "selected" : ""}>false (post to GitHub)</option>
            </select>
          </div>
          <div>
            <label>Max approvals / hour</label>
            <input type="number" name="max_approvals_per_hour" min="1" max="1000" value="${cfg.review.max_approvals_per_hour}">
          </div>
          <div>
            <label title="After this many consecutive failures on the same PR+SHA, the PR is dead-lettered — skipped from normal discovery and surfaced on the Dashboard's Needs attention card. 0 disables dead-lettering.">Dead-letter threshold (0 disables)</label>
            <input type="number" name="dead_letter_threshold" min="0" max="20" value="${cfg.review.dead_letter_threshold}">
          </div>
          <div>
            <label>Skip drafts</label>
            <select name="skip_drafts">
              <option value="true" ${cfg.review.skip_drafts ? "selected" : ""}>true</option>
              <option value="false" ${!cfg.review.skip_drafts ? "selected" : ""}>false</option>
            </select>
          </div>
          <div>
            <label title="Skip PRs authored by GitHub-flagged bot accounts: dependabot, renovate, github-actions, etc.">Skip bots</label>
            <select name="skip_bots">
              <option value="true" ${cfg.review.skip_bots ? "selected" : ""}>true</option>
              <option value="false" ${!cfg.review.skip_bots ? "selected" : ""}>false</option>
            </select>
          </div>
          <div>
            <label>Require CI green</label>
            <select name="require_ci_green">
              <option value="true" ${cfg.review.require_ci_green ? "selected" : ""}>true</option>
              <option value="false" ${!cfg.review.require_ci_green ? "selected" : ""}>false</option>
            </select>
          </div>
          <div>
            <label>Poll interval (seconds)</label>
            <input type="number" name="interval_seconds" min="10" value="${cfg.poll.interval_seconds}">
          </div>
          <div>
            <label>Claude CLI command</label>
            <input type="text" name="claude_command" value="${cfg.claude.command}">
          </div>
          <div>
            <label>Claude timeout (seconds)</label>
            <input type="number" name="claude_timeout_seconds" min="30" value="${cfg.claude.timeout_seconds}">
          </div>
          <div>
            <label title="How many PRs to review in parallel. Claude Max is sized for interactive use, not heavy concurrency. Start at 1; raise cautiously. Max 4.">Concurrency (1–4)</label>
            <input type="number" name="concurrency" min="1" max="4" value="${cfg.review.concurrency}">
          </div>
          <div>
            <label title="When a PR exceeds this file count, a lightweight triage pass runs to pick which files deserve deep review. Set very high to disable.">Large-PR file threshold</label>
            <input type="number" name="large_pr_threshold_files" min="5" max="500" value="${cfg.review.large_pr_threshold_files}">
          </div>
          <div>
            <label title="When total diff bytes exceeds this, triage also triggers. Short-circuits during accumulation, so 500KB+ PRs always trip it regardless of exact size.">Large-PR byte threshold</label>
            <input type="number" name="large_pr_threshold_bytes" min="10000" max="10000000" value="${cfg.review.large_pr_threshold_bytes}">
          </div>
          <div>
            <label title="After triage, this many top-priority files get the full review prompt. The rest are summarized as 'deferred' in the review summary.">Large-PR deep-review files</label>
            <input type="number" name="large_pr_deep_review_files" min="1" max="50" value="${cfg.review.large_pr_deep_review_files}">
          </div>
          <div>
            <label title="When on, each tick scans recently-reviewed PRs for new replies to the bot's line comments and responds in-thread. Off by default (costs extra Claude calls).">Threaded replies</label>
            <select name="threaded_replies">
              <option value="true" ${cfg.review.threaded_replies ? "selected" : ""}>true (iterate conversations)</option>
              <option value="false" ${!cfg.review.threaded_replies ? "selected" : ""}>false (drive-by reviews only)</option>
            </select>
          </div>
          <div>
            <label title="How many recently-reviewed PRs to scan per tick for new thread replies. Only used when Threaded replies is true.">Threaded-replies scan depth</label>
            <input type="number" name="threaded_replies_scan_recent" min="1" max="200" value="${cfg.review.threaded_replies_scan_recent}">
          </div>
        </div>

        <p class="muted space" style="font-size:12px">
          <strong>Concurrency note:</strong> Claude Max isn't built for many parallel sessions. 1 is the safe default. If you raise it, watch Events for a burst of <code>claude.failed</code> — that's the session hitting a burst limit, and you should drop back.
        </p>
        <p class="muted" style="font-size:12px">
          <strong>Large-PR triage:</strong> either threshold triggers an extra Claude call to triage files first, then a normal review on the top-priority subset. Two calls per large PR instead of one generic review on 50+ files.
        </p>

        <div class="space"><button type="submit">Save general</button></div>
      </form>
    </section>

    <section class="card">
      <h2>Watched orgs</h2>
      ${orgs.length === 0
        ? html`<p class="muted">No orgs. Add one below to watch every repo under it.</p>`
        : html`
          <table>
            <thead><tr><th>Name</th><th>Mode</th><th>Include</th><th>Exclude</th><th>Tone</th><th></th></tr></thead>
            <tbody>
              ${orgs.map((o) => html`
                <tr>
                  <td class="mono">${o.name}</td>
                  <td>${o.mode}</td>
                  <td class="mono muted">${parseArr(o.include_json).join(", ") || "—"}</td>
                  <td class="mono muted">${parseArr(o.exclude_json).join(", ") || "—"}</td>
                  <td class="muted">${o.tone_override === null ? "inherits default" : html`${o.tone_mode}s ${o.tone_override.length}c`}</td>
                  <td>
                    <div class="actions">
                      <a href="/config/orgs/${encodeURIComponent(o.name)}/edit">edit</a>
                      <form method="post" action="/config/orgs" class="inline">
                        <input type="hidden" name="_action" value="delete">
                        <input type="hidden" name="name" value="${o.name}">
                        <button type="submit" class="danger">delete</button>
                      </form>
                    </div>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      <form method="post" action="/config/orgs" class="space">
        <input type="hidden" name="_action" value="upsert">
        <div class="grid">
          <div><label>Org name</label><input type="text" name="name" required placeholder="my-org"></div>
          <div>
            <label>Mode</label>
            <select name="mode">
              <option value="all">all (every repo)</option>
              <option value="include">include (only listed)</option>
            </select>
          </div>
          <div><label>Include (comma-separated, used when mode=include)</label><input type="text" name="include" placeholder="repo-a, repo-b"></div>
          <div><label>Exclude (comma-separated, used when mode=all)</label><input type="text" name="exclude" placeholder="archived-thing"></div>
        </div>
        <div class="space"><button type="submit">Add / update org</button></div>
      </form>
    </section>

    <section class="card">
      <h2>GitHub OAuth</h2>
      <p><a href="/config/users">→ Manage users and roles</a> (admin only; visible only when OAuth is configured and a valid session exists).</p>
      <p class="muted">
        When both <code>github.oauth_client_id</code> (in the General form
        above) AND the <code>GITHUB_OAUTH_CLIENT_SECRET</code> env var are
        set, the UI switches from basic auth to session-based GitHub
        login. The first person to successfully sign in is auto-promoted
        to admin; subsequent logins come in as viewers. Admins manage
        roles on <a href="/config/users">/config/users</a>. Register the
        OAuth app at github.com/settings/developers with callback URL
        <code>&lt;your-host&gt;/auth/github/callback</code>. The client
        secret belongs in <code>.env</code> — it would be a mistake to
        store it in the DB where a snapshot could leak it.
      </p>
    </section>

    <section class="card">
      <h2>Webhook ingest</h2>
      <p class="muted">
        When a webhook secret is configured, GitHub can POST to
        <code>/webhook/github</code> to trigger a review immediately instead
        of waiting for the next poll. Pair with a Cloudflare Tunnel (or
        equivalent) to expose the endpoint without opening firewall ports.
        The signing secret is read from the <code>GITHUB_WEBHOOK_SECRET</code>
        environment variable and must match what's configured in the GitHub
        App / repository webhook.
      </p>
      ${webhook?.configured
        ? html`
          <div class="banner ok">Webhook signing secret is configured. POST <code>/webhook/github</code> with a valid signature to trigger an immediate review.</div>
        `
        : html`
          <div class="banner warn">Webhook ingest is disabled. Set <code>GITHUB_WEBHOOK_SECRET</code> in the environment to enable the <code>/webhook/github</code> endpoint.</div>
        `}
      <p class="muted" style="font-size:12px">
        Supported events: <code>pull_request</code> with action
        <code>opened</code>, <code>synchronize</code>, or <code>reopened</code>.
        Everything else (including <code>ping</code>) returns 200 but is
        ignored. Duplicate delivery IDs (GitHub retries) are absorbed by an
        internal dedup table.
      </p>
    </section>

    <section class="card">
      <h2>File-type tone templates</h2>
      <p class="muted">
        Each template appends extra guidance to the tone Claude sees when the
        PR diff contains at least one matching file. Lower-priority templates
        are appended first; higher-priority (more specific) guidance appears
        later in the final tone, closer to the review task instruction.
      </p>
      ${toneTemplates.length === 0
        ? html`<p class="muted">No templates yet. Add one to give Claude file-type-specific review lenses (e.g. Terraform security, React a11y, SQL migration safety).</p>`
        : html`
          <table>
            <thead><tr><th>Priority</th><th>Pattern</th><th>Addendum</th><th></th></tr></thead>
            <tbody>
              ${toneTemplates.map((t) => html`
                <tr>
                  <td class="mono">${t.priority}</td>
                  <td class="mono">${t.pattern}</td>
                  <td class="muted">${t.tone_addendum.length > 120 ? t.tone_addendum.slice(0, 117) + "…" : t.tone_addendum}</td>
                  <td>
                    <div class="actions">
                      <a href="/config/tone-templates/${t.id}/edit">edit</a>
                      <form method="post" action="/config/tone-templates/${t.id}" class="inline">
                        <input type="hidden" name="_action" value="delete">
                        <button type="submit" class="danger">delete</button>
                      </form>
                    </div>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      <div class="space"><a href="/config/tone-templates/new"><button type="button">Add template</button></a></div>
    </section>

    <section class="card">
      <h2>Watched individual repos</h2>
      ${repos.length === 0
        ? html`<p class="muted">No individual repos. Use this for one-off repos outside a watched org.</p>`
        : html`
          <table>
            <thead><tr><th>owner/name</th><th>Tone</th><th></th></tr></thead>
            <tbody>
              ${repos.map((r) => html`
                <tr>
                  <td class="mono">${r.slug}</td>
                  <td class="muted">${r.tone_override === null ? "inherits" : html`${r.tone_mode}s ${r.tone_override.length}c`}</td>
                  <td>
                    <div class="actions">
                      <a href="/config/repos/${sluggedPath(r.slug)}/edit">edit</a>
                      <form method="post" action="/config/repos" class="inline">
                        <input type="hidden" name="_action" value="delete">
                        <input type="hidden" name="slug" value="${r.slug}">
                        <button type="submit" class="danger">delete</button>
                      </form>
                    </div>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      <form method="post" action="/config/repos" class="space inline-form">
        <input type="hidden" name="_action" value="add">
        <input type="text" name="slug" required placeholder="owner/name">
        <button type="submit">Add repo</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout({
      title: "Config",
      active: "config",
      banner: errorBanner ?? args.banner ?? null,
      body,
      sessionUser: user,
    }),
  );
}

export async function handleGeneralPost(
  store: Store,
  form: FormData,
  currentCfg: Config,
): Promise<
  | { ok: true }
  | { ok: false; errors: FieldError[]; candidate: Config }
> {
  // Form → candidate Config. clampInt keeps obvious numeric garbage out,
  // but zod does the final authoritative check via validateConfig.
  const skip = splitLines(form.get("skip_authors"));
  const candidate: Config = {
    ...currentCfg,
    github: {
      bot_username: String(form.get("bot_username") ?? "").trim(),
      skip_authors: skip,
      oauth_client_id: String(form.get("oauth_client_id") ?? "").trim(),
    },
    review: {
      ...currentCfg.review,
      tone: String(form.get("tone") ?? ""),
      dry_run: String(form.get("dry_run") ?? "true") === "true",
      max_approvals_per_hour: clampInt(form.get("max_approvals_per_hour"), 1, 1000, 10),
      skip_drafts: String(form.get("skip_drafts") ?? "true") === "true",
      skip_bots: String(form.get("skip_bots") ?? "true") === "true",
      require_ci_green: String(form.get("require_ci_green") ?? "true") === "true",
      concurrency: clampInt(form.get("concurrency"), 1, 4, 1),
      dead_letter_threshold: clampInt(form.get("dead_letter_threshold"), 0, 20, 3),
      large_pr_threshold_files: clampInt(form.get("large_pr_threshold_files"), 5, 500, 25),
      large_pr_threshold_bytes: clampInt(form.get("large_pr_threshold_bytes"), 10_000, 10_000_000, 100_000),
      large_pr_deep_review_files: clampInt(form.get("large_pr_deep_review_files"), 1, 50, 15),
      threaded_replies: String(form.get("threaded_replies") ?? "false") === "true",
      threaded_replies_scan_recent: clampInt(form.get("threaded_replies_scan_recent"), 1, 200, 25),
      include_paths: splitLines(form.get("include_paths")),
      exclude_paths: splitLines(form.get("exclude_paths")),
    },
    poll: {
      interval_seconds: clampInt(form.get("interval_seconds"), 10, 86400, 60),
    },
    claude: {
      command: String(form.get("claude_command") ?? "claude").trim() || "claude",
      timeout_seconds: clampInt(form.get("claude_timeout_seconds"), 30, 3600, 600),
    },
  };

  // bot_username is allowed to be "" at the schema level (first-boot state),
  // but save-time we require it — users shouldn't be able to un-configure
  // the bot through the form.
  if (!candidate.github.bot_username) {
    return {
      ok: false,
      errors: [{ path: "github.bot_username", message: "required" }],
      candidate,
    };
  }

  const validated = validateConfig(candidate);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, candidate };
  }

  const cfg = validated.cfg;
  store.setScalar("github.bot_username", cfg.github.bot_username);
  store.setScalar("github.oauth_client_id", cfg.github.oauth_client_id);
  store.setScalar("review.dry_run", String(cfg.review.dry_run));
  store.setScalar("review.max_approvals_per_hour", String(cfg.review.max_approvals_per_hour));
  store.setScalar("review.tone", cfg.review.tone);
  store.setScalar("review.skip_drafts", String(cfg.review.skip_drafts));
  store.setScalar("review.skip_bots", String(cfg.review.skip_bots));
  store.setScalar("review.require_ci_green", String(cfg.review.require_ci_green));
  store.setScalar("poll.interval_seconds", String(cfg.poll.interval_seconds));
  store.setScalar("claude.command", cfg.claude.command);
  store.setScalar("claude.timeout_seconds", String(cfg.claude.timeout_seconds));
  store.setScalar("review.concurrency", String(cfg.review.concurrency));
  store.setScalar("review.dead_letter_threshold", String(cfg.review.dead_letter_threshold));
  store.setScalar("review.large_pr_threshold_files", String(cfg.review.large_pr_threshold_files));
  store.setScalar("review.large_pr_threshold_bytes", String(cfg.review.large_pr_threshold_bytes));
  store.setScalar("review.large_pr_deep_review_files", String(cfg.review.large_pr_deep_review_files));
  store.setScalar("review.threaded_replies", String(cfg.review.threaded_replies));
  store.setScalar("review.threaded_replies_scan_recent", String(cfg.review.threaded_replies_scan_recent));
  store.setScalar("review.include_paths", JSON.stringify(cfg.review.include_paths));
  store.setScalar("review.exclude_paths", JSON.stringify(cfg.review.exclude_paths));

  const existing = new Set(store.listSkipAuthors());
  const next = new Set(cfg.github.skip_authors);
  for (const u of existing) if (!next.has(u)) store.removeSkipAuthor(u);
  for (const u of next) if (!existing.has(u)) store.addSkipAuthor(u);

  recordAudit(store, {
    actor: currentActor(),
    action: "config.general.save",
    changes: diffGeneralConfig(currentCfg, cfg),
  });
  return { ok: true };
}

export function handleOrgsPost(
  store: Store,
  form: FormData,
): { ok: true; redirect: string } | { ok: false; error: string } {
  const action = String(form.get("_action") ?? "");
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "org name required" };

  if (action === "delete") {
    // Don't audit-log a no-op. A delete for a name that isn't in the
    // table is almost always a stale tab or a malformed curl; the
    // audit log is a record of actual state changes, and filling it
    // with phantom "deleted totally-fake" rows erodes its value.
    // deleteOrg itself is idempotent (DELETE WHERE name=?), so there's
    // nothing to undo on the silent-skip path.
    const existed = store.getOrg(name) !== null;
    store.deleteOrg(name);
    if (existed) {
      recordAudit(store, {
        actor: currentActor(),
        action: "config.org.delete",
        target: name,
      });
    }
    return { ok: true, redirect: "/config" };
  }
  if (action === "upsert") {
    const mode = String(form.get("mode") ?? "all");
    if (mode !== "all" && mode !== "include") return { ok: false, error: "invalid mode" };
    const include = splitCsv(form.get("include"));
    const exclude = splitCsv(form.get("exclude"));
    if (mode === "include" && include.length === 0) {
      return { ok: false, error: "include list required when mode=include" };
    }
    // The quick-add form on /config doesn't include tone fields. If this is an
    // update to an existing org, preserve its tone so we don't silently wipe
    // it; use defaults for a brand-new row.
    const existing = store.getOrg(name);
    store.upsertOrg({
      name,
      mode,
      include_json: JSON.stringify(include),
      exclude_json: JSON.stringify(exclude),
      tone_override: existing?.tone_override ?? null,
      tone_mode: existing?.tone_mode ?? "append",
    });
    recordAudit(store, {
      actor: currentActor(),
      action: "config.org.upsert",
      target: name,
      detail: `mode=${mode}`,
    });
    return { ok: true, redirect: "/config" };
  }
  return { ok: false, error: "unknown action" };
}

export function handleReposPost(
  store: Store,
  form: FormData,
): { ok: true; redirect: string } | { ok: false; error: string } {
  const action = String(form.get("_action") ?? "");
  const slug = String(form.get("slug") ?? "").trim();
  if (!slug) return { ok: false, error: "slug required" };
  if (!/^[^/]+\/[^/]+$/.test(slug)) return { ok: false, error: "slug must be owner/name" };

  if (action === "add") {
    store.addWatchedRepo(slug);
    recordAudit(store, {
      actor: currentActor(),
      action: "config.repo.add",
      target: slug,
    });
    return { ok: true, redirect: "/config" };
  }
  if (action === "delete") {
    // Same no-op guard as the org path above — no audit row for a
    // delete of a slug that wasn't in the table.
    const existed = store.getRepo(slug) !== null;
    store.removeWatchedRepo(slug);
    if (existed) {
      recordAudit(store, {
        actor: currentActor(),
        action: "config.repo.delete",
        target: slug,
      });
    }
    return { ok: true, redirect: "/config" };
  }
  return { ok: false, error: "unknown action" };
}

function splitLines(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitCsv(v: FormDataEntryValue | null): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clampInt(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function parseArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export { redirect };
