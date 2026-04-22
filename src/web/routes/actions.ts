import type { Store } from "../../state/db.ts";
import { redirect } from "../html.ts";

export function handleToggleDryRun(store: Store): Response {
  const current = store.getScalar("review.dry_run");
  const next = current === "true" || current === null ? "false" : "true";
  store.setScalar("review.dry_run", next);
  store.recordEvent({
    level: "warn",
    kind: "config.update",
    message: `dry_run flipped to ${next}`,
  });
  return redirect("/");
}

export function handleRecheck(store: Store, form: FormData): Response {
  const repo = String(form.get("repo") ?? "").trim();
  const prStr = String(form.get("pr") ?? "").trim();
  const pr = Number(prStr);
  if (!repo || !Number.isFinite(pr) || !Number.isInteger(pr)) {
    return redirect("/");
  }
  const removed = store.clearDedupe(repo, pr);
  store.recordEvent({
    level: "info",
    kind: "action.recheck",
    message: `cleared ${removed} dedupe row(s); will re-review on next tick`,
    repo,
    prNumber: pr,
  });
  return redirect(`/reviews/${encodeURIComponent(repo)}/${pr}`);
}
