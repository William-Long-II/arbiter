import type { Store } from "../../state/db.ts";
import { html, htmlResponse } from "../html.ts";
import { layout } from "../layout.ts";

export function eventsRoute(args: { store: Store }): Response {
  const events = args.store.recentEvents(200);
  const body = html`
    <section class="card">
      <h2>Events (last ${events.length})</h2>
      ${events.length === 0
        ? html`<p class="muted">No events yet.</p>`
        : html`
          <table>
            <thead><tr><th>Time</th><th>Level</th><th>Kind</th><th>Where</th><th>Message</th></tr></thead>
            <tbody>
              ${events.map((e) => html`
                <tr>
                  <td class="muted mono">${e.ts}</td>
                  <td class="lvl-${e.level} mono">${e.level}</td>
                  <td class="mono">${e.kind}</td>
                  <td class="mono muted">${formatWhere(e.repo, e.pr_number)}</td>
                  <td>${e.message}${e.payload ? html`<details><summary class="muted">payload</summary><pre>${pretty(e.payload)}</pre></details>` : ""}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>
  `;
  return htmlResponse(layout({ title: "Events", active: "events", body }));
}

function formatWhere(repo: string | null, pr: number | null): string {
  if (repo && pr) return `${repo}#${pr}`;
  if (repo) return repo;
  return "—";
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
