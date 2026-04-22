import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import { html, htmlResponse, redirect } from "../html.ts";
import { layout, type Banner } from "../layout.ts";

export function configRoute(args: {
  store: Store;
  cfg: Config;
  banner?: Banner | null;
}): Response {
  const { store, cfg } = args;
  const orgs = store.listOrgs();
  const repos = store.listWatchedRepoRows();
  const skipAuthors = store.listSkipAuthors();

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
        </div>

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
                  <td class="right">
                    <a href="/config/orgs/${encodeURIComponent(o.name)}/edit">edit</a>
                    &nbsp;
                    <form method="post" action="/config/orgs" class="inline">
                      <input type="hidden" name="_action" value="delete">
                      <input type="hidden" name="name" value="${o.name}">
                      <button type="submit" class="danger">delete</button>
                    </form>
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
                  <td class="right">
                    <a href="/config/repos/${repoEditPath(r.slug)}/edit">edit</a>
                    &nbsp;
                    <form method="post" action="/config/repos" class="inline">
                      <input type="hidden" name="_action" value="delete">
                      <input type="hidden" name="slug" value="${r.slug}">
                      <button type="submit" class="danger">delete</button>
                    </form>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
      <form method="post" action="/config/repos" class="space row">
        <input type="hidden" name="_action" value="add">
        <input type="text" name="slug" required placeholder="owner/name">
        <button type="submit">Add repo</button>
      </form>
    </section>
  `;

  return htmlResponse(layout({ title: "Config", active: "config", banner: args.banner ?? null, body }));
}

export async function handleGeneralPost(
  store: Store,
  form: FormData,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const bot = String(form.get("bot_username") ?? "").trim();
  if (!bot) return { ok: false, error: "bot_username is required" };

  const skip = String(form.get("skip_authors") ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const tone = String(form.get("tone") ?? "").trim();
  const dryRun = String(form.get("dry_run") ?? "true") === "true";
  const cap = clampInt(form.get("max_approvals_per_hour"), 1, 1000, 10);
  const skipDrafts = String(form.get("skip_drafts") ?? "true") === "true";
  const requireCi = String(form.get("require_ci_green") ?? "true") === "true";
  const interval = clampInt(form.get("interval_seconds"), 10, 86400, 60);
  const claudeCmd = String(form.get("claude_command") ?? "claude").trim() || "claude";
  const claudeTimeout = clampInt(form.get("claude_timeout_seconds"), 30, 3600, 600);

  store.setScalar("github.bot_username", bot);
  store.setScalar("review.dry_run", String(dryRun));
  store.setScalar("review.max_approvals_per_hour", String(cap));
  store.setScalar("review.tone", tone);
  store.setScalar("review.skip_drafts", String(skipDrafts));
  store.setScalar("review.require_ci_green", String(requireCi));
  store.setScalar("poll.interval_seconds", String(interval));
  store.setScalar("claude.command", claudeCmd);
  store.setScalar("claude.timeout_seconds", String(claudeTimeout));

  // Replace the skip-authors set (add new, remove missing).
  const existing = new Set(store.listSkipAuthors());
  const next = new Set(skip);
  for (const u of existing) if (!next.has(u)) store.removeSkipAuthor(u);
  for (const u of next) if (!existing.has(u)) store.addSkipAuthor(u);

  store.recordEvent({ level: "info", kind: "config.update", message: "general settings saved" });
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
    store.recordEvent({ level: "info", kind: "config.update", message: `org deleted: ${name}` });
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
    store.recordEvent({
      level: "info",
      kind: "config.update",
      message: `org upserted: ${name} (${mode})`,
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
    store.recordEvent({ level: "info", kind: "config.update", message: `repo added: ${slug}` });
    return { ok: true, redirect: "/config" };
  }
  if (action === "delete") {
    store.removeWatchedRepo(slug);
    store.recordEvent({ level: "info", kind: "config.update", message: `repo removed: ${slug}` });
    return { ok: true, redirect: "/config" };
  }
  return { ok: false, error: "unknown action" };
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

/**
 * Turn an "owner/name" slug into the two encoded path segments the server's
 * route matcher expects. encodeURIComponent on the whole slug turns `/` into
 * `%2F`, which then doesn't match the `:owner/:name` route pattern.
 */
function repoEditPath(slug: string): string {
  const [owner, name] = slug.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
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
