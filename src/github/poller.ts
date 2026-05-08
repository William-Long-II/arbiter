// Periodic poller — stub. Runs on a setInterval and:
//   1. For each user with enabled scopes, list PRs in scope targets.
//   2. Filter out self-authored, excluded-author, and draft PRs.
//   3. For each match, INSERT INTO pending_reviews ON CONFLICT DO NOTHING.
import { config } from '../config.ts';

let timer: ReturnType<typeof setInterval> | null = null;

export function startPoller(): void {
  if (timer) return;
  const ms = config.pollIntervalSeconds * 1000;
  console.log(`[poller] starting, interval=${config.pollIntervalSeconds}s`);
  timer = setInterval(() => {
    // TODO: poll loop
  }, ms);
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
