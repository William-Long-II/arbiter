import type { Config } from "./config.ts";
import type { Store } from "./state/db.ts";

/**
 * Audit log for any change that mutates operator-visible state.
 *
 * Why: previously mutations were recorded as generic events ("general
 * settings saved") with no before/after and no actor. When multi-user
 * auth lands (Sprint 5 / GitHub OAuth) we'll have a real per-session
 * actor; wiring the field now means we don't have to re-thread anything.
 *
 * For the single-operator phase, actor comes from AUTO_REVIEWER_OPERATOR
 * if set, otherwise "operator". That string appears verbatim in the
 * Events payload so a grep against history stays meaningful even after
 * OAuth turns it into a real login.
 */

export type AuditAction =
  | "config.general.save"
  | "config.org.upsert"
  | "config.org.delete"
  | "config.org.edit"
  | "config.repo.add"
  | "config.repo.delete"
  | "config.repo.edit"
  | "action.toggle_dry_run"
  | "action.recheck"
  | "auth.role_change"
  | "auth.user_delete";

export type AuditChange = {
  /** Dotted field path (e.g. "review.concurrency", "watch.repos"). */
  path: string;
  /** Stringified prior value, or null if the field was unset/new. */
  from: string | null;
  /** Stringified new value, or null if the field was removed. */
  to: string | null;
};

/**
 * Resolve the identity to record in audit events. When a GitHub OAuth
 * session is in play, the session's login wins. Otherwise we fall back
 * to the AUTO_REVIEWER_OPERATOR env var, then the generic "operator"
 * string. Accept an optional override so we don't have to wire async
 * local storage just for this.
 */
export function currentActor(opts?: { sessionLogin?: string | null }): string {
  if (opts?.sessionLogin) return opts.sessionLogin;
  return process.env.AUTO_REVIEWER_OPERATOR ?? "operator";
}

export function recordAudit(
  store: Store,
  args: {
    actor: string;
    action: AuditAction;
    /** Identifier of what was acted on (org name, repo slug, "repo#pr"). */
    target?: string;
    /** Structured diff; empty array is still legit for "edit saved nothing changed". */
    changes?: AuditChange[];
    /** Free-form context appended to the event message. */
    detail?: string;
  },
): void {
  const summary = describe(args);
  store.recordEvent({
    level: "info",
    kind: "audit." + args.action,
    message: summary,
    payload: {
      actor: args.actor,
      target: args.target,
      changes: args.changes,
      detail: args.detail,
    },
  });
}

function describe(args: {
  actor: string;
  action: AuditAction;
  target?: string;
  changes?: AuditChange[];
  detail?: string;
}): string {
  const who = args.actor;
  const what = actionLabel(args.action);
  const where = args.target ? ` ${args.target}` : "";
  const how =
    args.changes && args.changes.length > 0
      ? ` (${args.changes.length} field${args.changes.length === 1 ? "" : "s"} changed: ${args.changes
          .slice(0, 3)
          .map((c) => c.path)
          .join(", ")}${args.changes.length > 3 ? ", …" : ""})`
      : "";
  const extra = args.detail ? ` — ${args.detail}` : "";
  return `${who} ${what}${where}${how}${extra}`;
}

function actionLabel(a: AuditAction): string {
  switch (a) {
    case "config.general.save":
      return "saved general settings";
    case "config.org.upsert":
      return "added/updated org";
    case "config.org.delete":
      return "deleted org";
    case "config.org.edit":
      return "edited org";
    case "config.repo.add":
      return "added repo";
    case "config.repo.delete":
      return "deleted repo";
    case "config.repo.edit":
      return "edited repo";
    case "action.toggle_dry_run":
      return "toggled dry-run";
    case "action.recheck":
      return "requested recheck for";
    case "auth.role_change":
      return "changed role of";
    case "auth.user_delete":
      return "removed user";
  }
}

/**
 * Compute a diff between two Config values for the scalar + list fields the
 * General form owns. Org/repo subtree changes have their own audit actions,
 * so we don't diff watch.* here.
 *
 * Arrays (skip_authors, include_paths, exclude_paths) get a size-delta +
 * sample representation rather than a full JSON dump — an audit log that
 * embeds a 20KB tone change once is fine; embedding it on every read of
 * the Events page is not.
 */
export function diffGeneralConfig(before: Config, after: Config): AuditChange[] {
  const out: AuditChange[] = [];

  const scalar = (path: string, a: unknown, b: unknown) => {
    if (a === b) return;
    out.push({ path, from: safeStr(a), to: safeStr(b) });
  };

  scalar("github.bot_username", before.github.bot_username, after.github.bot_username);
  scalar("github.oauth_client_id", before.github.oauth_client_id, after.github.oauth_client_id);
  scalar("review.dry_run", before.review.dry_run, after.review.dry_run);
  scalar(
    "review.max_approvals_per_hour",
    before.review.max_approvals_per_hour,
    after.review.max_approvals_per_hour,
  );
  scalar("review.skip_drafts", before.review.skip_drafts, after.review.skip_drafts);
  scalar("review.skip_bots", before.review.skip_bots, after.review.skip_bots);
  scalar(
    "review.require_ci_green",
    before.review.require_ci_green,
    after.review.require_ci_green,
  );
  scalar("review.concurrency", before.review.concurrency, after.review.concurrency);
  scalar(
    "review.dead_letter_threshold",
    before.review.dead_letter_threshold,
    after.review.dead_letter_threshold,
  );
  scalar(
    "review.large_pr_threshold_files",
    before.review.large_pr_threshold_files,
    after.review.large_pr_threshold_files,
  );
  scalar(
    "review.large_pr_threshold_bytes",
    before.review.large_pr_threshold_bytes,
    after.review.large_pr_threshold_bytes,
  );
  scalar(
    "review.large_pr_deep_review_files",
    before.review.large_pr_deep_review_files,
    after.review.large_pr_deep_review_files,
  );
  scalar(
    "review.threaded_replies",
    before.review.threaded_replies,
    after.review.threaded_replies,
  );
  scalar(
    "review.threaded_replies_scan_recent",
    before.review.threaded_replies_scan_recent,
    after.review.threaded_replies_scan_recent,
  );
  scalar("poll.interval_seconds", before.poll.interval_seconds, after.poll.interval_seconds);
  scalar("claude.command", before.claude.command, after.claude.command);
  scalar("claude.timeout_seconds", before.claude.timeout_seconds, after.claude.timeout_seconds);

  // Tone is a long string — record a size delta + preview rather than
  // dumping the whole thing twice.
  if (before.review.tone !== after.review.tone) {
    out.push({
      path: "review.tone",
      from: preview(before.review.tone),
      to: preview(after.review.tone),
    });
  }

  diffList("github.skip_authors", before.github.skip_authors, after.github.skip_authors, out);
  diffList("review.include_paths", before.review.include_paths, after.review.include_paths, out);
  diffList("review.exclude_paths", before.review.exclude_paths, after.review.exclude_paths, out);

  return out;
}

function diffList(path: string, a: string[], b: string[], out: AuditChange[]): void {
  const sa = JSON.stringify([...a].sort());
  const sb = JSON.stringify([...b].sort());
  if (sa === sb) return;
  out.push({
    path,
    from: summarizeList(a),
    to: summarizeList(b),
  });
}

function summarizeList(xs: string[]): string {
  if (xs.length === 0) return "[]";
  if (xs.length <= 4) return `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
  return `[${xs.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}, … +${xs.length - 3}]`;
}

function safeStr(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

function preview(s: string): string {
  const chars = s.length;
  const head = s.slice(0, 60).replace(/\s+/g, " ");
  return `(${chars} chars) ${JSON.stringify(head)}${s.length > 60 ? "…" : ""}`;
}
