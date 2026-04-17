import type { Octokit } from "./client";

type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped"
  | "stale"
  | null;

type CheckRunStatus = "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";

export type CheckRunSummary = {
  name: string;
  status: CheckRunStatus;
  conclusion: CheckRunConclusion;
};

export type CiGateResult =
  | { green: true }
  | { green: false; reason: string; failingChecks: string[] };

/**
 * A check-run is considered passing if it completed and its conclusion is
 * one of the success-equivalent terminal states. `skipped` is allowed because
 * conditional jobs (e.g. path filters) legitimately skip.
 */
function isPassing(run: CheckRunSummary): boolean {
  if (run.status !== "completed") return false;
  return (
    run.conclusion === "success" ||
    run.conclusion === "neutral" ||
    run.conclusion === "skipped"
  );
}

export function evaluateCheckRuns(runs: CheckRunSummary[]): CiGateResult {
  if (runs.length === 0) {
    return { green: false, reason: "no check runs reported", failingChecks: [] };
  }

  const failing = runs.filter((r) => !isPassing(r));
  if (failing.length > 0) {
    return {
      green: false,
      reason: "one or more checks did not pass",
      failingChecks: failing.map((r) => r.name),
    };
  }

  return { green: true };
}

/**
 * Pulls every check-run for the commit and evaluates the aggregate status.
 * Uses check_runs (not commit statuses) because modern CI (GHA, Sonar, etc.)
 * all publish check-runs.
 */
export async function evaluateHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<CiGateResult> {
  const runs: CheckRunSummary[] = [];
  for await (const page of octokit.paginate.iterator(
    octokit.checks.listForRef,
    { owner, repo, ref: sha, per_page: 100 },
  )) {
    for (const run of page.data) {
      runs.push({
        name: run.name,
        status: run.status as CheckRunStatus,
        conclusion: run.conclusion as CheckRunConclusion,
      });
    }
  }
  return evaluateCheckRuns(runs);
}
