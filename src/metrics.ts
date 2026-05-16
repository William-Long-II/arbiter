// Prometheus metrics. `renderPrometheus` is pure (text-format escaping,
// unit-tested); `collectMetrics` does the DB + poller reads. Deliberately
// a small, high-signal set — queue health, spend, poller liveness — not a
// firehose.

import { sql } from './db.ts';
import { getPollerStatus } from './github/poller.ts';
import { getWorkerStatus } from './worker.ts';

const REVIEW_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'skipped',
] as const;

export type MetricSample = { labels?: Record<string, string>; value: number };
export type MetricFamily = {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: MetricSample[];
};

function escapeHelp(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function escapeLabelValue(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function fmtValue(v: number): string {
  return Number.isFinite(v) ? String(v) : '0';
}

/**
 * Render families into the Prometheus text exposition format. Pure — the
 * scrape endpoint just wraps this. Each family emits its HELP/TYPE header
 * once, then one line per sample.
 */
export function renderPrometheus(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const f of families) {
    lines.push(`# HELP ${f.name} ${escapeHelp(f.help)}`);
    lines.push(`# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) {
      const labels = s.labels
        ? '{' +
          Object.entries(s.labels)
            .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
            .join(',') +
          '}'
        : '';
      lines.push(`${f.name}${labels} ${fmtValue(s.value)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Snapshot the metric families. One GROUP BY for the queue, one aggregate
 * for spend + oldest-queued age, plus the in-process poller status.
 */
export async function collectMetrics(): Promise<MetricFamily[]> {
  const statusRows = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n
    FROM pending_reviews
    GROUP BY status
  `;
  const counts = new Map(statusRows.map((r) => [r.status, r.n]));

  const [agg] = await sql<{ oldest: number | null; cost: number }[]>`
    SELECT
      EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE status = 'queued')))::float8 AS oldest,
      COALESCE(SUM(cost_usd), 0)::float8 AS cost
    FROM pending_reviews
  `;

  const poller = getPollerStatus();
  const lastTickAgeSec = poller.lastTickAt
    ? Math.max(0, (Date.now() - new Date(poller.lastTickAt).getTime()) / 1000)
    : 0;

  const worker = getWorkerStatus();

  return [
    {
      name: 'arbiter_reviews',
      help: 'Reviews in the queue by status.',
      type: 'gauge',
      samples: REVIEW_STATUSES.map((status) => ({
        labels: { status },
        value: counts.get(status) ?? 0,
      })),
    },
    {
      name: 'arbiter_queue_oldest_seconds',
      help: 'Age of the oldest queued review (0 when the queue is empty).',
      type: 'gauge',
      samples: [{ value: agg?.oldest ?? 0 }],
    },
    {
      name: 'arbiter_review_cost_usd',
      help: 'Sum of model cost (USD) over retained reviews. Gauge — retention prunes old rows.',
      type: 'gauge',
      samples: [{ value: agg?.cost ?? 0 }],
    },
    {
      name: 'arbiter_poller_last_tick_seconds',
      help: 'Seconds since the poller last ran (0 if it has not ticked yet).',
      type: 'gauge',
      samples: [{ value: lastTickAgeSec }],
    },
    {
      name: 'arbiter_poller_in_flight',
      help: '1 while a poll tick is running, else 0.',
      type: 'gauge',
      samples: [{ value: poller.inFlight ? 1 : 0 }],
    },
    {
      name: 'arbiter_worker_active',
      help: 'Reviews currently being processed by the worker pool.',
      type: 'gauge',
      samples: [{ value: worker.active }],
    },
    {
      name: 'arbiter_worker_concurrency',
      help: 'Configured max concurrent reviews per process (saturation = active / concurrency).',
      type: 'gauge',
      samples: [{ value: worker.concurrency }],
    },
  ];
}
