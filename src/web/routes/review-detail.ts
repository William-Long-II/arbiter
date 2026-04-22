import type { Store } from "../../state/db.ts";
import { html, htmlResponse } from "../html.ts";
import { layout } from "../layout.ts";

type StoredNote = {
  verdict: "approve" | "request_changes" | "dry_run" | "skipped";
  summary: string;
  valid: Array<{
    path: string;
    line: number;
    side: "RIGHT" | "LEFT";
    body: string;
    severity: "nit" | "suggestion" | "issue" | "blocker";
  }>;
  dropped: Array<{
    comment: {
      path: string;
      line: number;
      side: "RIGHT" | "LEFT";
      body: string;
      severity: "nit" | "suggestion" | "issue" | "blocker";
    };
    reason: string;
  }>;
};

export function reviewDetailRoute(args: {
  store: Store;
  repo: string;
  pr: number;
}): Response {
  const review = args.store.getReview(args.repo, args.pr);
  if (!review) {
    return htmlResponse(
      layout({
        title: "Review not found",
        body: html`<section class="card"><p>No review recorded for <code>${args.repo}#${args.pr}</code>.</p></section>`,
      }),
      404,
    );
  }

  const parsed = tryParseNote(review.note);

  const body = html`
    <section class="card">
      <h2>${args.repo} #${args.pr}</h2>
      <div class="grid">
        <div class="stat"><div class="k">Verdict</div><div class="v"><span class="tag ${review.verdict}">${review.verdict.replace("_", " ")}</span></div></div>
        <div class="stat"><div class="k">SHA</div><div class="v mono">${review.head_sha.slice(0, 10)}</div></div>
        <div class="stat"><div class="k">Reviewed</div><div class="v">${review.reviewed_at}</div></div>
      </div>
      <div class="space">
        <form method="post" action="/actions/recheck" class="inline">
          <input type="hidden" name="repo" value="${args.repo}">
          <input type="hidden" name="pr" value="${args.pr}">
          <button type="submit" class="danger">Clear dedupe → re-review on next tick</button>
        </form>
      </div>
    </section>

    ${parsed ? html`
      <section class="card">
        <h2>Summary</h2>
        <pre>${parsed.summary}</pre>
      </section>

      <section class="card">
        <h2>Line comments (${parsed.valid.length})</h2>
        ${parsed.valid.length === 0
          ? html`<p class="muted">None.</p>`
          : html`
            <table>
              <thead><tr><th>Severity</th><th>File</th><th>Line</th><th>Comment</th></tr></thead>
              <tbody>
                ${parsed.valid.map((c) => html`
                  <tr>
                    <td><span class="tag ${c.severity}">${c.severity}</span></td>
                    <td class="mono">${c.path}</td>
                    <td class="mono">${c.side === "LEFT" ? "−" : ""}${c.line}</td>
                    <td><pre>${c.body}</pre></td>
                  </tr>
                `)}
              </tbody>
            </table>
          `}
      </section>

      ${parsed.dropped.length > 0 ? html`
        <section class="card">
          <h2>Dropped comments (${parsed.dropped.length})</h2>
          <p class="muted">Claude attached these to lines not present in the diff. They are folded into the summary above so the reader still sees them.</p>
          <table>
            <thead><tr><th>Severity</th><th>File</th><th>Line</th><th>Reason</th><th>Comment</th></tr></thead>
            <tbody>
              ${parsed.dropped.map((d) => html`
                <tr>
                  <td><span class="tag ${d.comment.severity}">${d.comment.severity}</span></td>
                  <td class="mono">${d.comment.path}</td>
                  <td class="mono">${d.comment.line}</td>
                  <td class="muted">${d.reason}</td>
                  <td><pre>${d.comment.body}</pre></td>
                </tr>
              `)}
            </tbody>
          </table>
        </section>
      ` : ""}
    ` : html`
      <section class="card">
        <h2>Note</h2>
        <pre>${review.note ?? "(empty)"}</pre>
      </section>
    `}
  `;

  return htmlResponse(layout({ title: `${args.repo}#${args.pr}`, body }));
}

function tryParseNote(s: string | null): StoredNote | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== "object") return null;
    if (typeof v.summary !== "string") return null;
    return v as StoredNote;
  } catch {
    return null;
  }
}
