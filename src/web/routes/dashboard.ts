import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import type { Runtime } from "../runtime.ts";
import { isConfigured } from "../../config.ts";
import { sluggedPath } from "../../github/slug.ts";
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

  const breakerState = runtime.breaker.inspect();
  const banner: Banner | null = !isConfigured(cfg)
    ? {
        kind: "warn",
        message:
          "Setup not complete. Set github.bot_username and add at least one org or repo in Config before the bot will review anything.",
      }
    : breakerState.kind === "open"
      ? {
          kind: "err",
          message: `Claude circuit breaker is OPEN. No reviews are running until it closes. Last reason: ${breakerState.lastReason}. Check Events for details.`,
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
        <div class="stat"><div class="k">Next tick</div><div class="v" id="stat-next-tick" data-at="${runtime.nextTickAt ?? ""}">${runtime.nextTickAt ? "…" : (runtime.currentPrs.length > 0 ? "reviewing" : "discovering")}</div></div>
        <div class="stat"><div class="k">Concurrency</div><div class="v" id="stat-concurrency">${cfg.review.concurrency}</div></div>
        <div class="stat">
          <div class="k">Breaker</div>
          <div class="v" id="stat-breaker" data-reopens-at="${breakerState.kind === "open" ? new Date(breakerState.reopensAt).toISOString() : ""}">${breakerLabel(breakerState)}</div>
        </div>
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
      <div id="recent-reviews" data-interval-seconds="${cfg.poll.interval_seconds}">
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
                    <td class="muted" data-at="${r.reviewed_at}">${fmtRel(r.reviewed_at)}</td>
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
      </div>
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
 * Dashboard live-update primitive — a thin "reactive" layer, no framework.
 *
 * The page server-renders a full state once. After that, the script keeps
 * it fresh via:
 *
 *   1. A single `/api/status` poll every 5s that returns EVERY dashboard
 *      data point as one JSON blob.
 *   2. A registry mapping DOM element id -> function(element, state). The
 *      registry runs each renderer on every poll. Adding a new live card
 *      is: give the host element an id, add a render function, done.
 *   3. A 1s local "tick" that reformats time-relative strings (countdown,
 *      "Xs ago", elapsed seconds) without needing a poll. Targets cells
 *      annotated with data-at / data-started attributes — no renderer
 *      needs to opt in.
 *
 * Why not a framework: the dashboard has ~6 reactive regions and the whole
 * app is build-free. Pulling in React/Svelte/etc is disproportionate. When
 * we outgrow this (say, fine-grained diffing of 1000-row tables), swap
 * the registry out for a real library; the registry pattern makes the
 * swap local, not project-wide.
 */
const DASHBOARD_SCRIPT = `
(function(){
  //
  // ─── utils ────────────────────────────────────────────────────────────
  //
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
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
  function fmtBreaker(b){
    if (!b) return '—';
    if (b.kind === 'closed') {
      var n = b.consecutiveFailures || 0;
      return n > 0 ? 'closed (' + n + ' fail' + (n === 1 ? '' : 's') + ')' : 'closed';
    }
    if (b.kind === 'half_open') return 'half-open (trial)';
    var remaining = Math.max(0, Math.ceil((b.reopensAt - Date.now()) / 1000));
    return 'open (' + remaining + 's left)';
  }

  //
  // ─── renderer registry ────────────────────────────────────────────────
  //
  // Each entry: given the target element and the full status object, write
  // that element's current representation. The element is allowed to not
  // exist (renderer is a no-op in that case) so the same registry works on
  // future pages that reuse a subset of sections.
  //
  var renderers = {
    'stat-mode': function(el, s){ el.textContent = s.mode; },
    'stat-approvals': function(el, s){
      el.textContent = s.approvalsInLastHour + ' / ' + s.approvalCap;
    },
    'stat-concurrency': function(el, s){
      if (typeof s.concurrency === 'number') el.textContent = s.concurrency;
    },
    'stat-breaker': function(el, s){
      if (!s.breaker) return;
      if (s.breaker.kind === 'open') {
        el.dataset.reopensAt = new Date(s.breaker.reopensAt).toISOString();
      } else {
        el.dataset.reopensAt = '';
      }
      el.textContent = fmtBreaker(s.breaker);
    },
    'stat-next-tick': function(el, s){
      el.dataset.at = s.nextTickAt || '';
      // renderNextTick does the actual text update (also called from the
      // 1s tick). Here we just reseed the target and let the tick paint.
      renderNextTick();
    },
    'stat-last-activity': function(el, s){
      el.dataset.at = s.lastActivityAt || '';
      el.textContent = fmtRel(s.lastActivityAt);
    },
    'stat-tick-error': function(el, s){
      el.textContent = s.lastTickError ? 'last tick error: ' + s.lastTickError : '';
    },
    'stat-storage-size': function(el, s){
      if (s.storage) el.textContent = (s.storage.sizeBytes / 1024).toFixed(1) + ' KB';
    },
    'stat-storage-reviews': function(el, s){
      if (s.storage) el.textContent = s.storage.counts.reviews;
    },
    'stat-storage-events': function(el, s){
      if (s.storage) el.textContent = s.storage.counts.events;
    },
    'stat-storage-orgs': function(el, s){
      if (s.storage) el.textContent = s.storage.counts.orgs;
    },
    'stat-storage-repos': function(el, s){
      if (s.storage) el.textContent = s.storage.counts.repos;
    },
    'current-prs': function(el, s){
      var list = Array.isArray(s.currentPrs) ? s.currentPrs : [];
      if (!list.length) {
        el.innerHTML = '<p class="muted">Idle. Next PR will be processed on the next tick.</p>';
        return;
      }
      var rows = list.map(function(p){
        return '<tr data-started="' + escapeHtml(p.startedAt) + '">' +
          '<td class="mono">' + escapeHtml(p.repo) + '</td>' +
          '<td class="mono">#' + escapeHtml(p.number) + '</td>' +
          '<td class="muted current-elapsed">' + escapeHtml(fmtElapsed(p.startedAt)) + '</td>' +
        '</tr>';
      }).join('');
      el.innerHTML =
        '<table><thead><tr><th>Repo</th><th>PR</th><th>Elapsed</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    },
    'recent-reviews': function(el, s){
      var list = Array.isArray(s.recentReviews) ? s.recentReviews : [];
      if (!list.length) {
        var interval = el.dataset.intervalSeconds || '60';
        el.innerHTML = '<p class="muted">No reviews yet. The loop runs every ' +
          escapeHtml(interval) + 's.</p>';
        return;
      }
      var rows = list.map(function(r){
        var sha = String(r.head_sha || '').slice(0, 7);
        var verdictLabel = String(r.verdict || '').replace('_', ' ');
        return '<tr>' +
          '<td class="muted" data-at="' + escapeHtml(r.reviewed_at) + '">' +
            escapeHtml(fmtRel(r.reviewed_at)) + '</td>' +
          '<td class="mono"><a href="' + escapeHtml(r.detail_url) + '">' + escapeHtml(r.repo) + '</a></td>' +
          '<td class="mono">#' + escapeHtml(r.pr_number) + '</td>' +
          '<td><span class="tag ' + escapeHtml(r.verdict) + '">' + escapeHtml(verdictLabel) + '</span></td>' +
          '<td class="mono">' + escapeHtml(sha) + '</td>' +
          '<td class="right"><a href="' + escapeHtml(r.detail_url) + '">detail →</a></td>' +
        '</tr>';
      }).join('');
      el.innerHTML =
        '<table><thead><tr><th>When</th><th>Repo</th><th>PR</th><th>Verdict</th>' +
        '<th class="mono">SHA</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    },
  };

  //
  // ─── state the 1s tick needs ──────────────────────────────────────────
  //
  var targetMs = null; // next-tick countdown target, derived from data-at

  function renderNextTick(){
    var el = document.getElementById('stat-next-tick');
    if (!el) return;
    // If the server cleared nextTickAt, a tick is in progress. Disambiguate
    // phase 1 (listing — no PR picked up) from phase 2 (workers active) by
    // looking at the current-prs DOM rather than piping state through.
    if (targetMs === null) {
      var activeRows = document.querySelectorAll('#current-prs tr[data-started]');
      el.textContent = activeRows.length > 0 ? 'reviewing' : 'discovering';
      return;
    }
    el.textContent = fmtCountdown(Math.ceil((targetMs - Date.now()) / 1000));
  }

  //
  // ─── application ──────────────────────────────────────────────────────
  //
  function applyStatus(s){
    // Update the countdown target BEFORE running renderers, because the
    // stat-next-tick renderer calls renderNextTick() which reads it.
    targetMs = s.nextTickAt ? Date.parse(s.nextTickAt) : null;
    if (isNaN(targetMs)) targetMs = null;
    for (var id in renderers) {
      var el = document.getElementById(id);
      if (el) renderers[id](el, s);
    }
  }

  // Seed countdown from server-rendered data-at so the first paint shows
  // a real value, not a poll-latency flicker.
  (function seed(){
    var el = document.getElementById('stat-next-tick');
    if (el && el.dataset.at) {
      var t0 = Date.parse(el.dataset.at);
      targetMs = isNaN(t0) ? null : t0;
    }
    renderNextTick();
  })();

  // 1s local ticks — reformat time-relative cells without hitting the poll.
  // Every [data-at] cell gets fmtRel; every [data-started] cell inside a
  // #current-prs table gets fmtElapsed. The breaker "open (Xs left)"
  // counter is reticked here too so it drifts between 5s polls.
  setInterval(function(){
    renderNextTick();
    var atCells = document.querySelectorAll('[data-at]');
    for (var i = 0; i < atCells.length; i++) {
      var c = atCells[i];
      // Countdown target is handled separately (not an "Xs ago").
      if (c.id === 'stat-next-tick') continue;
      if (c.dataset.at) c.textContent = fmtRel(c.dataset.at);
    }
    var currentRows = document.querySelectorAll('#current-prs tr[data-started]');
    for (var j = 0; j < currentRows.length; j++) {
      var cell = currentRows[j].querySelector('.current-elapsed');
      if (cell) cell.textContent = fmtElapsed(currentRows[j].dataset.started);
    }
    var brk = document.getElementById('stat-breaker');
    if (brk && brk.dataset.reopensAt) {
      var at = Date.parse(brk.dataset.reopensAt);
      if (!isNaN(at)) {
        var remaining = Math.max(0, Math.ceil((at - Date.now()) / 1000));
        brk.textContent = 'open (' + remaining + 's left)';
      }
    }
  }, 1000);

  async function poll(){
    try {
      var r = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      applyStatus(await r.json());
    } catch (e) { /* transient — try again next interval */ }
  }
  // NOTE: no immediate poll() on load. The server-rendered HTML already
  // reflects current state at render time; firing fetch() a few ms later
  // only replaces identical data with identical data. First poll happens
  // at the 5s mark, then every 5s thereafter.
  setInterval(poll, 5000);
})();
`;

function reviewUrl(repo: string, pr: number): string {
  return `/reviews/${sluggedPath(repo)}/${pr}`;
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

function breakerLabel(state: import("../runtime.ts").Runtime["breaker"] extends { inspect(): infer S } ? S : never): string {
  if (state.kind === "closed") {
    const n = (state as { consecutiveFailures: number }).consecutiveFailures;
    return n > 0 ? `closed (${n} fail${n === 1 ? "" : "s"})` : "closed";
  }
  if (state.kind === "half_open") return "half-open (trial)";
  // open
  const reopensAt = (state as { reopensAt: number }).reopensAt;
  const remaining = Math.max(0, Math.ceil((reopensAt - Date.now()) / 1000));
  return `open (${remaining}s left)`;
}
