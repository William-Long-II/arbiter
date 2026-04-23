import type { Store } from "../../state/db.ts";
import type { Config, FieldError } from "../../config.ts";
import { validateConfig } from "../../config.ts";
import { sluggedPath } from "../../github/slug.ts";
import { currentActor, diffGeneralConfig, recordAudit } from "../../audit.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout, type Banner } from "../layout.ts";

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
}): Response {
  const { store, cfg, errors } = args;
  const orgs = store.listOrgs();
  const repos = store.listWatchedRepoRows();
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
        </div>

        <p class="muted space" style="font-size:12px">
          <strong>Concurrency note:</strong> Claude Max isn't built for many parallel sessions. 1 is the safe default. If you raise it, watch Events for a burst of <code>claude.failed</code> — that's the session hitting a burst limit, and you should drop back.
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
    store.deleteOrg(name);
    recordAudit(store, {
      actor: currentActor(),
      action: "config.org.delete",
      target: name,
    });
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
    store.removeWatchedRepo(slug);
    recordAudit(store, {
      actor: currentActor(),
      action: "config.repo.delete",
      target: slug,
    });
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
