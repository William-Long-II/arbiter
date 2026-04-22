import type { GH } from "./client.ts";
import type { RepoRef } from "./discover.ts";

export type CiStatus =
  | { kind: "green" }
  | { kind: "pending"; pending: string[] }
  | { kind: "failing"; failing: string[] }
  | { kind: "none" };

/**
 * Collapse check-runs + commit-status API into a single decision.
 * We ignore checks that look like "required review/approval" gates — the
 * whole point of this bot is to BE that approval.
 */
export async function evaluateCi(gh: GH, repo: RepoRef, sha: string): Promise<CiStatus> {
  const [checks, statuses] = await Promise.all([
    gh.checks.listForRef({ owner: repo.owner, repo: repo.name, ref: sha, per_page: 100 }),
    gh.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.name, ref: sha }),
  ]);

  const failing: string[] = [];
  const pending: string[] = [];
  let anyPresent = false;

  for (const run of checks.data.check_runs) {
    if (isApprovalGate(run.name)) continue;
    anyPresent = true;
    if (run.status !== "completed") {
      pending.push(run.name);
      continue;
    }
    const c = run.conclusion;
    if (c === "success" || c === "neutral" || c === "skipped") continue;
    failing.push(`${run.name}:${c ?? "unknown"}`);
  }

  for (const s of statuses.data.statuses) {
    if (isApprovalGate(s.context)) continue;
    anyPresent = true;
    if (s.state === "success") continue;
    if (s.state === "pending") pending.push(s.context);
    else failing.push(`${s.context}:${s.state}`);
  }

  if (!anyPresent) return { kind: "none" };
  if (failing.length > 0) return { kind: "failing", failing };
  if (pending.length > 0) return { kind: "pending", pending };
  return { kind: "green" };
}

function isApprovalGate(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("approval") ||
    n.includes("approve") ||
    n.includes("code review") ||
    n.includes("required reviews")
  );
}
