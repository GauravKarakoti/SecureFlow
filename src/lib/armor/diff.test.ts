/**
 * Tests for the shared unified-diff parser (#589).
 *
 * The last section is the point of the whole exercise: it feeds the same
 * fixtures through both projections and asserts they agree. Before the two
 * parsers were merged, several of those fixtures produced a numbered snippet
 * whose line numbers were absent from the commentable set — which is how a
 * finding ends up anchored on the wrong line or silently dropped from the
 * inline review.
 */
import { describe, it, expect, vi } from 'vitest';

// The worker module instantiates a BullMQ Worker at import time. This test
// imports it on purpose — the last describe block asserts the worker and the
// scanner agree — so the queue transport is stubbed the same way worker.test.ts
// stubs it.
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(function (this: any) {
    this.on = vi.fn();
  }),
  Queue: vi.fn().mockImplementation(function (this: any) {
    this.add = vi.fn();
  }),
}));
vi.mock('@/lib/queue/redis', () => ({ redis: {} }));
vi.mock('@/ai/flows/developer-receives-ai-security-explanations', () => ({
  developerReceivesAISecurityExplanations: vi.fn(),
}));

import {
  addedLines,
  commentableLineNumbers,
  lineAt,
  parseUnifiedPatch,
  renderNumberedLines,
} from './diff';
import { extractAddedLines } from './scanner';
import { getCommentableLines } from '@/lib/queue/worker';

const patch = (...lines: string[]) => lines.join('\n');

describe('parseUnifiedPatch — hunk headers', () => {
  it('starts numbering from the new-side start of the hunk', () => {
    const parsed = parseUnifiedPatch(patch('@@ -10,3 +20,3 @@', ' a();', '+b();'));

    expect(parsed.lines).toEqual([
      { number: 20, content: 'a();', kind: 'context' },
      { number: 21, content: 'b();', kind: 'added' },
    ]);
  });

  it('accepts a header without line counts', () => {
    const parsed = parseUnifiedPatch(patch('@@ -1 +7 @@', '+seven();'));

    expect(parsed.lines).toEqual([{ number: 7, content: 'seven();', kind: 'added' }]);
  });

  it('restarts numbering at every hunk and counts them', () => {
    const parsed = parseUnifiedPatch(
      patch('@@ -1,1 +1,1 @@', '+first();', '@@ -50,1 +60,1 @@', '+second();'),
    );

    expect(parsed.hunkCount).toBe(2);
    expect(parsed.lines.map((l) => l.number)).toEqual([1, 60]);
  });

  it('reports zero hunks for a patch with no header', () => {
    expect(parseUnifiedPatch(patch(' unchanged', '+added')).hunkCount).toBe(0);
  });

  it('keeps the section context lines carry when there is no header at all', () => {
    // GitHub always sends a header, but a hand-built fixture may not; numbering
    // from zero is the documented behaviour the scanner has always had.
    const parsed = parseUnifiedPatch(patch(' unchanged', '+added'));

    expect(parsed.lines.map((l) => l.number)).toEqual([0, 1]);
  });
});

describe('parseUnifiedPatch — markers', () => {
  it('does not advance the counter for a deleted line', () => {
    const parsed = parseUnifiedPatch(
      patch('@@ -1,3 +1,2 @@', ' keep();', '-removed();', '+added();'),
    );

    expect(parsed.lines.map((l) => `${l.number}:${l.content}`)).toEqual(['1:keep();', '2:added();']);
  });

  it('never surfaces the text of a deleted line', () => {
    const parsed = parseUnifiedPatch(
      patch('@@ -1,2 +1,1 @@', '-const OLD = "ghp_removed";', '+const NEW = 1;'),
    );

    expect(renderNumberedLines(parsed)).not.toContain('ghp_removed');
  });

  it('keeps an added line whose content starts with ++', () => {
    const parsed = parseUnifiedPatch(
      patch('@@ -1,3 +1,5 @@', ' let i = 0;', '+++i;', '+const KEY = "ghp_x";'),
    );

    expect(parsed.lines.map((l) => `${l.number}:${l.content}`)).toEqual([
      '1:let i = 0;',
      '2:++i;',
      '3:const KEY = "ghp_x";',
    ]);
  });

  it('keeps an added line whose content starts with --', () => {
    const parsed = parseUnifiedPatch(patch('@@ -1,1 +1,2 @@', '+--i;', ' done();'));

    expect(parsed.lines.map((l) => l.content)).toEqual(['--i;', 'done();']);
  });

  it('keeps a marker-less empty context line in the numbering', () => {
    const parsed = parseUnifiedPatch(patch('@@ -1,3 +1,3 @@', ' a();', '', ' b();'));

    expect(parsed.lines.map((l) => l.number)).toEqual([1, 2, 3]);
    expect(parsed.lines[1]).toEqual({ number: 2, content: '', kind: 'context' });
  });

  it('ignores the no-newline marker without consuming a number', () => {
    const parsed = parseUnifiedPatch(
      patch('@@ -1,2 +1,2 @@', '+const x = 1;', '\\ No newline at end of file', '+const y = 2;'),
    );

    expect(parsed.lines.map((l) => `${l.number}:${l.content}`)).toEqual([
      '1:const x = 1;',
      '2:const y = 2;',
    ]);
  });

  it('does not emit a trailing entry for a patch ending in a newline', () => {
    const parsed = parseUnifiedPatch('@@ -1,1 +1,1 @@\n+const x = 1;\n');

    expect(parsed.lines).toHaveLength(1);
  });

  it('returns nothing for an empty patch', () => {
    expect(parseUnifiedPatch('')).toEqual({ lines: [], hunkCount: 0 });
  });
});

describe('parseUnifiedPatch — headers and metadata', () => {
  it('strips genuine file headers before the first hunk', () => {
    const parsed = parseUnifiedPatch(
      patch('--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,1 +1,1 @@', '+const x = 1;'),
    );

    expect(parsed.lines).toEqual([{ number: 1, content: 'const x = 1;', kind: 'added' }]);
  });

  it('strips git metadata lines before the first hunk', () => {
    const parsed = parseUnifiedPatch(
      patch(
        'diff --git a/src/app.ts b/src/app.ts',
        'index 1234567..89abcde 100644',
        'new file mode 100644',
        'similarity index 92%',
        'rename from src/old.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,1 +1,1 @@',
        '+const x = 1;',
      ),
    );

    expect(parsed.lines).toEqual([{ number: 1, content: 'const x = 1;', kind: 'added' }]);
  });

  it('treats a header-shaped line inside a hunk as content', () => {
    // A patch file checked into the repository, or a diff pasted into a
    // markdown block, is source text — not metadata to be eaten.
    const parsed = parseUnifiedPatch(
      patch('@@ -1,2 +1,3 @@', '+--- not a header', '+diff --git in a string', ' next();'),
    );

    expect(parsed.lines.map((l) => `${l.number}:${l.content}`)).toEqual([
      '1:--- not a header',
      '2:diff --git in a string',
      '3:next();',
    ]);
  });

  it('drops an unrecognised line without shifting the numbering after it', () => {
    const parsed = parseUnifiedPatch(patch('@@ -1,2 +1,2 @@', '+a();', '?????', '+b();'));

    expect(parsed.lines.map((l) => l.number)).toEqual([1, 2]);
  });
});

describe('projections', () => {
  const parsed = parseUnifiedPatch(
    patch('@@ -10,3 +10,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;', ' const c = 4;'),
  );

  it('renderNumberedLines emits every new-side line with its number', () => {
    expect(renderNumberedLines(parsed)).toBe(
      ['10: const a = 1;', '11: const b = 3;', '12: const c = 4;'].join('\n'),
    );
  });

  it('commentableLineNumbers covers added and context lines only', () => {
    expect([...commentableLineNumbers(parsed)].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it('addedLines returns only what the pull request adds', () => {
    expect(addedLines(parsed)).toEqual([{ number: 11, content: 'const b = 3;', kind: 'added' }]);
  });

  it('lineAt resolves a number back to its text', () => {
    expect(lineAt(parsed, 11)?.content).toBe('const b = 3;');
    expect(lineAt(parsed, 99)).toBeNull();
  });

  it('yields an empty commentable set for a hunk that only removes lines', () => {
    const removals = parseUnifiedPatch(patch('@@ -5,2 +5,0 @@', '-gone one', '-gone two'));

    expect(commentableLineNumbers(removals).size).toBe(0);
  });
});

/**
 * The regression the module exists for.
 *
 * Every line the model is told about must be a line an inline comment can be
 * anchored on. When these two disagree, a finding is either demoted to the
 * summary body or — if the shifted number happens to collide with a real one —
 * anchored on the wrong line of the file.
 */
describe('the scanner and the worker agree on every line number', () => {
  const fixtures: Array<[string, string]> = [
    ['plain hunk', patch('@@ -1,3 +1,4 @@', ' a();', '+b();', ' c();')],
    [
      'marker-less empty context line',
      patch('@@ -1,4 +1,5 @@', ' const a = 1;', '', '+const KEY = "AKIAIOSFODNN7EXAMPLE";', ' const b = 2;'),
    ],
    [
      'file headers present',
      patch('--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' a();', '+b();'),
    ],
    [
      'no-newline marker',
      patch('@@ -1,2 +1,2 @@', '+const x = 1;', '\\ No newline at end of file', ' const y = 2;'),
    ],
    ['increment operator as content', patch('@@ -1,2 +1,3 @@', ' let i = 0;', '+++i;', '+use(i);')],
    [
      'multiple hunks',
      patch('@@ -1,2 +1,3 @@', ' one', '+two', '@@ -20,1 +21,2 @@', '+twentyone', '+twentytwo'),
    ],
    ['deletions only', patch('@@ -5,2 +5,0 @@', '-gone one', '-gone two')],
    ['trailing newline', '@@ -1,1 +1,1 @@\n+const x = 1;\n'],
  ];

  it.each(fixtures)('%s', (_name, source) => {
    const snippet = extractAddedLines(source);
    const commentable = getCommentableLines(source);

    const reported = snippet
      .split('\n')
      .filter(Boolean)
      .map((row) => Number(row.slice(0, row.indexOf(':'))));

    for (const number of reported) {
      expect(commentable.has(number)).toBe(true);
    }

    // And nothing extra: a commentable line the model was never shown is a line
    // we could anchor a comment on without knowing what is written there.
    expect([...commentable].sort((x, y) => x - y)).toEqual([...new Set(reported)].sort((x, y) => x - y));
  });
});
