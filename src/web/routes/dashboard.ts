import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import type { Runtime } from "../runtime.ts";
import { isConfigured } from "../../config.ts";
import { html, htmlResponse, raw } from "../html.ts";
import { layout, type Banner } from "../layout.ts";

export function dashboardRoute(args: {
  store: Store;
  cfg: Config;
  runtime: Runtime;
}): Response {
  const { store, cfg, runtime } = args;
  const reviews = store.recentReviews(50);
  const approvalsHour = store.approvalsInLastHour();
  const watched = cfg.watch.orgs.length + cfg.watch.repos.length;
  const counts = store.counts();

  const banner: Banner | null = !isConfigured(cfg)
    ? {
        kind: "warn",
        message:
          "Setup not complete. Set github.bot_username and add at least one org or repo in Config before the bot will review anything.",
      }
    : cfg.review.dry_run
      ? {
          kind: "ok",
          message:
            "Dry-run is ON. Reviews are computed and logged but NOT posted to GitHub. Disable in Config when you trust the output.",
        }
      : null;

  const body = html`
    <section class="card">
      <h2>Status</h2>
      <div class="grid">
        <div class="stat"><div class="k">Mode</div><div class="v" id="stat-mode">${cfg.review.dry_run ? "dry-run" : "live"}</div></div>
        <div class="stat"><div class="k">Approvals / hr (rolling)</div><div class="v" id="stat-approvals">${approvalsHour} / ${cfg.review.max_approvals_per_hour}</div></div>
        <div class="stat"><div class="k">Watched</div><div class="v">${watched} ${watched === 1 ? "entry" : "entries"}</div></div>
        <div class="stat"><div class="k">Poll interval</div><div class="v">${cfg.poll.interval_seconds}s</div></div>
        <div class="stat"><div class="k">Last activity</div><div class="v" id="stat-last-activity" data-at="${runtime.lastActivityAt ?? ""}">${fmtRel(runtime.lastActivityAt)}</div></div>
        <div class="stat"><div class="k">Next tick</div><div class="v" id="stat-next-tick" data-at="${runtime.nextTickAt ?? ""}">${runtime.nextTickAt ? "…" : "running"}</div></div>
        <div class="stat"><div class="k">Concurrency</div><div class="v" id="stat-concurrency">${cfg.review.concurrency}</div></div>
        <div class="stat"><div class="k">Bot user</div><div class="v">${cfg.github.bot_username || "—"}</div></div>
      </div>
      <div class="space flex">
        <form method="post" action="/actions/toggle-dry-run" class="inline">
          <button type="submit">Flip dry-run → ${cfg.review.dry_run ? "live" : "dry-run"}</button>
        </form>
        <span class="lvl-error" id="stat-tick-error">${runtime.lastTickError ? `last tick error: ${runtime.lastTickError}` : ""}</span>
      </div>
    </section>

    <section class="card">
      <h2>Currently reviewing</h2>
      <div id="current-prs" data-render-now="${new Date().toISOString()}">
        ${runtime.currentPrs.length === 0
          ? html`<p class="muted">Idle. Next PR will be processed on the next tick.</p>`
          : html`
            <table>
              <thead><tr><th>Repo</th><th>PR</th><th>Elapsed</th></tr></thead>
              <tbody>
                ${runtime.currentPrs.map((p) => html`
                  <tr data-started="${p.startedAt}">
                    <td class="mono">${p.repo}</td>
                    <td class="mono">#${p.number}</td>
                    <td class="muted current-elapsed">${fmtElapsed(p.startedAt)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
      </div>
    </section>

    <section class="card">
      <h2>Storage</h2>
      ${store.meta.freshlyCreated ? html`<div class="banner err">This DB was created on THIS boot. If you had settings before, your <code>./data</code> volume didn't persist. Fix the mount before configuring again.</div>` : ""}
      <div class="grid">
        <div class="stat"><div class="k">DB path</div><div class="v mono" style="font-size:12.5px">${store.meta.path}</div></div>
        <div class="stat"><div class="k">Size</div><div class="v" id="stat-storage-size">${(store.meta.sizeBytes / 1024).toFixed(1)} KB</div></div>
        <div class="stat"><div class="k">Reviews</div><div class="v" id="stat-storage-reviews">${counts.reviews}</div></div>
        <div class="stat"><div class="k">Events</div><div class="v" id="stat-storage-events">${counts.events}</div></div>
        <div class="stat"><div class="k">Orgs</div><div class="v" id="stat-storage-orgs">${counts.orgs}</div></div>
        <div class="stat"><div class="k">Repos</div><div class="v" id="stat-storage-repos">${counts.repos}</div></div>
      </div>
    </section>

    <section class="card">
      <h2>Recent reviews</h2>
      ${reviews.length === 0
        ? html`<p class="muted">No reviews yet. The loop runs every ${cfg.poll.interval_seconds}s.</p>`
        : html`
          <table>
            <thead><tr>
              <th>When</th><th>Repo</th><th>PR</th><th>Verdict</th><th class="mono">SHA</th><th></th>
            </tr></thead>
            <tbody>
              ${reviews.map((r) => html`
                <tr>
                  <td class="muted">${fmtRel(r.reviewed_at)}</td>
                  <td class="mono"><a href="${reviewUrl(r.repo, r.pr_number)}">${r.repo}</a></td>
                  <td class="mono">#${r.pr_number}</td>
                  <td><span class="tag ${r.verdict}">${r.verdict.replace("_", " ")}</span></td>
                  <td class="mono">${r.head_sha.slice(0, 7)}</td>
                  <td class="right"><a href="${reviewUrl(r.repo, r.pr_number)}">detail →</a></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout({
      title: "Dashboard",
      active: "dashboard",
      banner,
      body,
      footScript: raw(DASHBOARD_SCRIPT),
    }),
  );
}

/**
 * Keeps the dashboard stat cards fresh without a page reload.
 *
 *   - #stat-next-tick: 1s local countdown based on the latest nextTickAt.
 *   - #stat-last-tick and other cards: refreshed every 5s by polling
 *     /api/status. This is what stops the UI getting stuck on "running"
 *     when a tick finishes server-side — previously the page had no way
 *     to know the tick was over until the user reloaded.
 *
 * When a tick is in progress the server sends nextTickAt=null; the UI
 * shows "running" and the local timer pauses. When the tick completes
 * and the server sets a new nextTickAt, the next poll picks it up and
 * the countdown resumes.
 */
const DASHBOARD_SCRIPT = `
(function(){
  var nextEl = document.getElementById('stat-next-tick');
  var lastEl = document.getElementById('stat-last-activity');
  var concEl = document.getElementById('stat-concurrency');
  var currentContainer = document.getElementById('current-prs');
  var errEl = document.getElementById('stat-tick-error');
  var modeEl = document.getElementById('stat-mode');
  var approvalsEl = document.getElementById('stat-approvals');
  var targetMs = null;
  // Remembered copy of the last-seen currentPrs list so renderElapsed can
  // keep ticking the per-PR elapsed seconds between 5s polls.
  var activePrs = [];

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  function fmtElapsed(iso){
    var t = Date.parse(iso);
    if (isNaN(t)) return '—';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s % 60) + 's';
    return Math.floor(s/3600) + 'h ' + Math.floor((s % 3600)/60) + 'm';
  }

  function fmtCountdown(s){
    if (s <= 0) return 'now';
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return m + 'm ' + r + 's';
    var h = Math.floor(m / 60), rm = m % 60;
    return h + 'h ' + rm + 'm';
  }
  function fmtRel(iso){
    if (!iso) return '—';
    var t = Date.parse(iso);
    if (isNaN(t)) return '—';
    var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }

  function renderNextTick(){
    if (!nextEl) return;
    if (targetMs === null) { nextEl.textContent = 'running'; return; }
    nextEl.textContent = fmtCountdown(Math.ceil((targetMs - Date.now()) / 1000));
  }

  function renderCurrentPrs(){
    if (!currentContainer) return;
    if (!activePrs.length) {
      currentContainer.innerHTML = '<p class="muted">Idle. Next PR will be processed on the next tick.</p>';
      return;
    }
    var rows = activePrs.map(function(p){
      return '<tr data-started="' + escapeHtml(p.startedAt) + '">' +
        '<td class="mono">' + escapeHtml(p.repo) + '</td>' +
        '<td class="mono">#' + escapeHtml(p.number) + '</td>' +
        '<td class="muted current-elapsed">' + escapeHtml(fmtElapsed(p.startedAt)) + '</td>' +
      '</tr>';
    }).join('');
    currentContainer.innerHTML =
      '<table><thead><tr><th>Repo</th><th>PR</th><th>Elapsed</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';
  }

  function tickCurrentElapsed(){
    // Update only the elapsed column in-place; preserves DOM stability and
    // avoids recreating the table every second.
    if (!currentContainer) return;
    var rows = currentContainer.querySelectorAll('tr[data-started]');
    for (var i = 0; i < rows.length; i++) {
      var cell = rows[i].querySelector('.current-elapsed');
      if (cell) cell.textContent = fmtElapsed(rows[i].dataset.started);
    }
  }

  function applyStatus(s){
    if (nextEl) {
      targetMs = s.nextTickAt ? Date.parse(s.nextTickAt) : null;
      if (isNaN(targetMs)) targetMs = null;
      nextEl.dataset.at = s.nextTickAt || '';
    }
    renderNextTick();
    if (lastEl) {
      lastEl.dataset.at = s.lastActivityAt || '';
      lastEl.textContent = fmtRel(s.lastActivityAt);
    }
    activePrs = Array.isArray(s.currentPrs) ? s.currentPrs : [];
    renderCurrentPrs();
    if (concEl && typeof s.concurrency === 'number') concEl.textContent = s.concurrency;
    if (errEl) errEl.textContent = s.lastTickError ? 'last tick error: ' + s.lastTickError : '';
    if (modeEl) modeEl.textContent = s.mode;
    if (approvalsEl) approvalsEl.textContent = s.approvalsInLastHour + ' / ' + s.approvalCap;
    if (s.storage) {
      var setText = function(id, v){ var e = document.getElementById(id); if (e) e.textContent = v; };
      setText('stat-storage-size', (s.storage.sizeBytes / 1024).toFixed(1) + ' KB');
      setText('stat-storage-reviews', s.storage.counts.reviews);
      setText('stat-storage-events', s.storage.counts.events);
      setText('stat-storage-orgs', s.storage.counts.orgs);
      setText('stat-storage-repos', s.storage.counts.repos);
    }
  }

  // Seed from the server-rendered data-at so the countdown starts immediately,
  // without waiting for the first poll.
  if (nextEl && nextEl.dataset.at) {
    var t0 = Date.parse(nextEl.dataset.at);
    targetMs = isNaN(t0) ? null : t0;
  }
  renderNextTick();

  // 1s local ticks: countdown text, "Xs ago" label, per-PR elapsed counters.
  setInterval(function(){
    renderNextTick();
    if (lastEl && lastEl.dataset.at) lastEl.textContent = fmtRel(lastEl.dataset.at);
    tickCurrentElapsed();
  }, 1000);

  async function poll(){
    try {
      var r = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      applyStatus(await r.json());
    } catch (e) { /* transient — try again next interval */ }
  }
  poll();
  setInterval(poll, 5000);
})();
`;

function reviewUrl(repo: string, pr: number): string {
  // Emit owner and name as SEPARATE path segments. Encoding the whole
  // "owner/name" with encodeURIComponent produces "owner%2Fname" which
  // the route matcher reads as a single segment and fails to match the
  // three-segment :owner/:name/:pr pattern.
  const [owner, name] = repo.split("/");
  return `/reviews/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${pr}`;
}

function fmtRel(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtElapsed(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
