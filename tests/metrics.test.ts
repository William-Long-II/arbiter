import { describe, expect, test } from 'bun:test';
import { renderPrometheus, type MetricFamily } from '../src/metrics.ts';

describe('renderPrometheus', () => {
  test('emits HELP/TYPE once per family then one line per sample', () => {
    const families: MetricFamily[] = [
      {
        name: 'arbiter_reviews',
        help: 'Reviews by status.',
        type: 'gauge',
        samples: [
          { labels: { status: 'queued' }, value: 3 },
          { labels: { status: 'done' }, value: 10 },
        ],
      },
      {
        name: 'arbiter_queue_oldest_seconds',
        help: 'Oldest queued age.',
        type: 'gauge',
        samples: [{ value: 42 }],
      },
    ];
    expect(renderPrometheus(families)).toBe(
      [
        '# HELP arbiter_reviews Reviews by status.',
        '# TYPE arbiter_reviews gauge',
        'arbiter_reviews{status="queued"} 3',
        'arbiter_reviews{status="done"} 10',
        '# HELP arbiter_queue_oldest_seconds Oldest queued age.',
        '# TYPE arbiter_queue_oldest_seconds gauge',
        'arbiter_queue_oldest_seconds 42',
        '',
      ].join('\n'),
    );
  });

  test('escapes HELP text and label values', () => {
    const out = renderPrometheus([
      {
        name: 'm',
        help: 'back\\slash and\nnewline',
        type: 'gauge',
        samples: [{ labels: { l: 'a"b\\c\nd' }, value: 1 }],
      },
    ]);
    expect(out).toContain('# HELP m back\\\\slash and\\nnewline');
    expect(out).toContain('m{l="a\\"b\\\\c\\nd"} 1');
  });

  test('non-finite values render as 0; output ends with a newline', () => {
    const out = renderPrometheus([
      {
        name: 'm',
        help: 'h',
        type: 'gauge',
        samples: [{ value: NaN }, { value: Infinity }, { value: 0.0125 }],
      },
    ]);
    expect(out).toContain('\nm 0\nm 0\nm 0.0125\n');
    expect(out.endsWith('\n')).toBe(true);
  });

  test('empty family list ⇒ just a newline', () => {
    expect(renderPrometheus([])).toBe('\n');
  });
});
