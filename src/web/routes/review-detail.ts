import type { Store } from "../../state/db.ts";
import { html, htmlResponse } from "../html.ts";
import { layout, type SessionUser } from "../layout.ts";

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
  /** Present on reviews recorded after per-repo tones shipped. Older rows omit it. */
  tone_used?: string;
  /** Present on reviews recorded after the intent pipeline shipped. Older rows omit it. */
  tickets?: Array<{
    kind: string;
    key: string;
    title: string;
    url: string;
    isPullRequest?: boolean;
  }>;
  /** Present only on large PRs where triage ran and narrowed the deep-review set. */
  triage?: {
    deep: string[];
    deferred: string[];
    entries: Array<{ path: string; priority: "high" | "medium" | "low"; reason: string }>;
  };
  /** Present only on reviews where at least one file-type tone template fired. */
  tone_templates?: Array<{
    id: number;
    pattern: string;
    priority: number;
    matched_paths: string[];
    matched_count: number;
  }>;
};

export function reviewDetailRoute(args: {
  store: Store;
  repo: string;
  pr: number;
  user?: SessionUser | null;
}): Response {
  const review = args.store.getReview(args.repo, args.pr);
  if (!review) {
    return htmlResponse(
      layout({
        title: "Review not found",
        body: html`<section class="card"><p>No review recorded for <code>${args.repo}#${args.pr}</code>.</p></section>`,
        sessionUser: args.user,
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
          <input type="hidden" name="head_sha" value="${review.head_sha}">
          <button type="submit" class="danger">Re-review this SHA</button>
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

      ${parsed.tickets && parsed.tickets.length > 0 ? html`
        <section class="card">
          <h2>Linked tickets (${parsed.tickets.length})</h2>
          <p class="muted">Claude was given context from these linked issues/PRs so it could review against the ticket's intent, not just code quality.</p>
          <table>
            <thead><tr><th>Ref</th><th>Title</th><th></th></tr></thead>
            <tbody>
              ${parsed.tickets.map((t) => html`
                <tr>
                  <td class="mono">${t.key}${t.isPullRequest ? " (PR)" : ""}</td>
                  <td>${t.title}</td>
                  <td class="right"><a href="${t.url}" target="_blank" rel="noreferrer">open →</a></td>
                </tr>
              `)}
            </tbody>
          </table>
        </section>
      ` : ""}

      ${parsed.triage ? html`
        <section class="card">
          <h2>Large-PR triage</h2>
          <p class="muted">This PR was large enough to trigger a lightweight triage pass. Claude classified every changed file, and only the top-priority subset was deep-reviewed. Deferred files are still noted in the review summary.</p>
          <div class="grid">
            <div class="stat"><div class="k">Deep-reviewed</div><div class="v">${parsed.triage.deep.length}</div></div>
            <div class="stat"><div class="k">Deferred</div><div class="v">${parsed.triage.deferred.length}</div></div>
            <div class="stat"><div class="k">Classified</div><div class="v">${parsed.triage.entries.length}</div></div>
          </div>
          ${parsed.triage.entries.length > 0 ? html`
            <table>
              <thead><tr><th>Priority</th><th>File</th><th>Reviewed?</th><th>Reason</th></tr></thead>
              <tbody>
                ${(() => {
                  const deepSet = new Set(parsed.triage.deep);
                  const order: Record<"high" | "medium" | "low", number> = { high: 0, medium: 1, low: 2 };
                  const rows = [...parsed.triage.entries].sort((a, b) => order[a.priority] - order[b.priority]);
                  return rows.map((e) => html`
                    <tr>
                      <td><span class="tag ${e.priority}">${e.priority}</span></td>
                      <td class="mono">${e.path}</td>
                      <td>${deepSet.has(e.path) ? "yes" : html`<span class="muted">no</span>`}</td>
                      <td class="muted">${e.reason}</td>
                    </tr>
                  `);
                })()}
              </tbody>
            </table>
          ` : ""}
        </section>
      ` : ""}

      ${parsed.tone_templates && parsed.tone_templates.length > 0 ? html`
        <section class="card">
          <h2>Tone templates fired (${parsed.tone_templates.length})</h2>
          <p class="muted">These file-type templates matched at least one changed file; their guidance was appended to the tone sent to Claude. Higher-priority templates appear later in the final tone.</p>
          <table>
            <thead><tr><th>Priority</th><th>Pattern</th><th>Matched</th><th>Sample files</th></tr></thead>
            <tbody>
              ${parsed.tone_templates.map((t) => html`
                <tr>
                  <td class="mono">${t.priority}</td>
                  <td class="mono">${t.pattern}</td>
                  <td class="mono">${t.matched_count}</td>
                  <td class="mono muted">${t.matched_paths.join(", ")}${t.matched_count > t.matched_paths.length ? ", …" : ""}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </section>
      ` : ""}

      ${parsed.tone_used !== undefined ? html`
        <section class="card">
          <h2>Tone used</h2>
          <details>
            <summary class="muted">The exact tone text Claude received for this review (not posted to GitHub — prompt-time only).</summary>
            <pre>${parsed.tone_used || "(empty)"}</pre>
          </details>
        </section>
      ` : ""}

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

  return htmlResponse(layout({ title: `${args.repo}#${args.pr}`, body, sessionUser: args.user }));
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
