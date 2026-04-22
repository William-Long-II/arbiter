import type { Store } from "../../state/db.ts";
import type { Config } from "../../config.ts";
import type { Runtime } from "../runtime.ts";
import { isConfigured } from "../../config.ts";
import { html, htmlResponse } from "../html.ts";
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
        <div class="stat"><div class="k">Mode</div><div class="v">${cfg.review.dry_run ? "dry-run" : "live"}</div></div>
        <div class="stat"><div class="k">Approvals / hr (rolling)</div><div class="v">${approvalsHour} / ${cfg.review.max_approvals_per_hour}</div></div>
        <div class="stat"><div class="k">Watched</div><div class="v">${watched} ${watched === 1 ? "entry" : "entries"}</div></div>
        <div class="stat"><div class="k">Poll interval</div><div class="v">${cfg.poll.interval_seconds}s</div></div>
        <div class="stat"><div class="k">Last tick</div><div class="v">${fmtRel(runtime.lastTickEnd)}</div></div>
        <div class="stat"><div class="k">Bot user</div><div class="v">${cfg.github.bot_username || "—"}</div></div>
      </div>
      <div class="space flex">
        <form method="post" action="/actions/toggle-dry-run" class="inline">
          <button type="submit">Flip dry-run → ${cfg.review.dry_run ? "live" : "dry-run"}</button>
        </form>
        ${runtime.lastTickError ? html`<span class="lvl-error">last tick error: ${runtime.lastTickError}</span>` : ""}
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
    layout({ title: "Dashboard", active: "dashboard", banner, body }),
  );
}

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
