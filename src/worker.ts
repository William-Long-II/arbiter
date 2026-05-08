// Review queue worker — stub.
// Loop:
//   1. SELECT FROM pending_reviews WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
//   2. Mark running, run review, post to GitHub, mark done/failed.
import { config } from './config.ts';

let timer: ReturnType<typeof setInterval> | null = null;

export function startWorker(): void {
  if (timer) return;
  const ms = config.workerIntervalSeconds * 1000;
  console.log(`[worker] starting, interval=${config.workerIntervalSeconds}s`);
  timer = setInterval(() => {
    // TODO: drain queue
  }, ms);
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
