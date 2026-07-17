import { describe, expect, test } from 'bun:test';
import {
  assembleCompareDelta,
  type ChangedFile,
  type CompareResult,
} from '../src/github/pulls.ts';

function file(over: Partial<ChangedFile> & { filename: string }): ChangedFile {
  return {
    status: 'modified',
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: '@@ -1 +1 @@\n-a\n+b',
    ...over,
  };
}

function cmp(over: Partial<CompareResult> = {}): CompareResult {
  return {
    status: 'ahead',
    files: [file({ filename: 'src/x.ts' })],
    commitParentCounts: [1, 1],
    ...over,
  };
}

describe('assembleCompareDelta', () => {
  test('clean fast-forward delta builds a git-style diff', () => {
    const delta = assembleCompareDelta(
      cmp({ files: [file({ filename: 'src/x.ts' }), file({ filename: 'src/y.ts' })] }),
    );
    expect(delta).not.toBeNull();
    expect(delta!.filesShown).toBe(2);
    expect(delta!.diff).toContain('diff --git a/src/x.ts b/src/x.ts');
    expect(delta!.diff).toContain('+++ b/src/y.ts');
    expect(delta!.diff).toContain('@@ -1 +1 @@');
  });

  test('rebase/force-push (diverged) falls back to full review', () => {
    expect(assembleCompareDelta(cmp({ status: 'diverged' }))).toBeNull();
    expect(assembleCompareDelta(cmp({ status: 'behind' }))).toBeNull();
    expect(assembleCompareDelta(cmp({ status: 'identical' }))).toBeNull();
  });

  test('a merge commit in the range (base merged into branch) falls back', () => {
    // The merge drags the whole upstream diff into the compare — reviewing
    // that as "your changes since last review" would be wrong and huge.
    expect(
      assembleCompareDelta(cmp({ commitParentCounts: [1, 2, 1] })),
    ).toBeNull();
  });

  test('empty or possibly-truncated (300-file cap) file lists fall back', () => {
    expect(assembleCompareDelta(cmp({ files: [] }))).toBeNull();
    const many = Array.from({ length: 300 }, (_, i) =>
      file({ filename: `f${i}.ts` }),
    );
    expect(assembleCompareDelta(cmp({ files: many }))).toBeNull();
  });

  test('binary-only changes fall back; mixed keeps only patched files', () => {
    const binary = file({ filename: 'logo.png', patch: undefined });
    expect(assembleCompareDelta(cmp({ files: [binary] }))).toBeNull();
    const delta = assembleCompareDelta(
      cmp({ files: [binary, file({ filename: 'src/x.ts' })] }),
    );
    expect(delta).not.toBeNull();
    expect(delta!.filesShown).toBe(1);
    expect(delta!.diff).not.toContain('logo.png');
  });

  test('added and removed files render /dev/null sides like the large-diff path', () => {
    const delta = assembleCompareDelta(
      cmp({
        files: [
          file({ filename: 'new.ts', status: 'added' }),
          file({ filename: 'gone.ts', status: 'removed' }),
        ],
      }),
    );
    expect(delta!.diff).toContain('--- /dev/null\n+++ b/new.ts');
    expect(delta!.diff).toContain('--- a/gone.ts\n+++ /dev/null');
  });
});
