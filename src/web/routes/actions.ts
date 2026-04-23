import type { Store } from "../../state/db.ts";
import { currentActor, recordAudit } from "../../audit.ts";
import { sluggedPath } from "../../github/slug.ts";
import { redirect } from "../html.ts";

function parseTriple(form: FormData): { repo: string; pr: number; sha: string } | null {
  const repo = String(form.get("repo") ?? "").trim();
  const prStr = String(form.get("pr") ?? "").trim();
  const sha = String(form.get("head_sha") ?? "").trim();
  const pr = Number(prStr);
  if (!repo || !Number.isInteger(pr) || !sha) return null;
  return { repo, pr, sha };
}

export function handleRetryFailure(store: Store, form: FormData): Response {
  const t = parseTriple(form);
  if (!t) return redirect("/");
  store.clearFailure(t.repo, t.pr, t.sha);
  recordAudit(store, {
    actor: currentActor(),
    action: "action.recheck",
    target: `${t.repo}#${t.pr}`,
    detail: `retry from dead-letter (SHA ${t.sha.slice(0, 7)})`,
  });
  return redirect("/");
}

export function handleDismissFailure(store: Store, form: FormData): Response {
  const t = parseTriple(form);
  if (!t) return redirect("/");
  store.dismissFailure(t.repo, t.pr, t.sha);
  recordAudit(store, {
    actor: currentActor(),
    action: "action.recheck",
    target: `${t.repo}#${t.pr}`,
    detail: `dismissed dead-letter (SHA ${t.sha.slice(0, 7)})`,
  });
  return redirect("/");
}

export function handleToggleDryRun(store: Store): Response {
  const before = store.getScalar("review.dry_run");
  const next = before === "true" || before === null ? "false" : "true";
  store.setScalar("review.dry_run", next);
  recordAudit(store, {
    actor: currentActor(),
    action: "action.toggle_dry_run",
    changes: [{ path: "review.dry_run", from: before ?? "true", to: next }],
  });
  return redirect("/");
}

export function handleRecheck(store: Store, form: FormData): Response {
  const repo = String(form.get("repo") ?? "").trim();
  const prStr = String(form.get("pr") ?? "").trim();
  const pr = Number(prStr);
  const sha = String(form.get("head_sha") ?? "").trim() || undefined;
  if (!repo || !Number.isFinite(pr) || !Number.isInteger(pr)) {
    return redirect("/");
  }
  const removed = store.clearDedupe(repo, pr, sha);
  recordAudit(store, {
    actor: currentActor(),
    action: "action.recheck",
    target: `${repo}#${pr}`,
    detail: sha
      ? `SHA ${sha.slice(0, 7)} — next tick will re-review this commit`
      : `cleared ${removed} dedupe row(s) — next tick will re-review`,
  });
  return redirect(`/reviews/${sluggedPath(repo)}/${pr}`);
}
