/**
 * The one place a unified diff is read.
 *
 * Two things need to know what a patch contains, and they need to agree:
 *
 *  - the scanner, which renders the numbered snippet handed to the model, and
 *  - the webhook worker, which decides which line numbers GitHub will accept an
 *    inline review comment on.
 *
 * They used to be separate parsers written months apart (`extractAddedLines` in
 * `./scanner` and `getCommentableLines` in `@/lib/queue/worker`), and they did
 * not agree. `extractAddedLines` had been hardened three times — `inHunk`
 * tracking so `++i;` isn't mistaken for a `+++ b/file` header, the
 * no-newline marker, marker-less empty context lines — and none of that ever
 * reached the other copy. The result was that the line number the model was
 * told about and the set of lines a comment could be anchored on drifted apart
 * inside the same hunk, so findings were dropped to the summary body or, worse,
 * anchored on a neighbouring line (#589).
 *
 * The fix is structural rather than a third round of the same patch: parse
 * once, into a shape that carries everything both callers need, and derive both
 * projections from that walk. The two views cannot disagree because there is
 * only one traversal.
 */

/**
 * What a line is on the *new* side of the diff.
 *
 * `added` is a `+` line, `context` is an unchanged line carried into the new
 * file. Deleted lines have no new-side identity and are not represented at all
 * — they consume no line number and must never be scanned, since the pull
 * request removes them.
 */
export type DiffLineKind = 'added' | 'context';

export interface DiffLine {
  /** Line number in the file as it will exist after the pull request merges. */
  number: number;
  /** The line's text, with the diff marker stripped. */
  content: string;
  kind: DiffLineKind;
}

export interface ParsedPatch {
  /** Every new-side line the patch describes, in file order. */
  lines: DiffLine[];
  /** How many `@@` hunks were seen. Zero means the patch had no header. */
  hunkCount: number;
}

/**
 * `@@ -old,count +new,count @@` — the counts are optional, because git omits
 * them for a single-line range (`@@ -1 +7 @@`).
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A real `---` / `+++` file header: the marker followed by whitespace or the
 * end of the line.
 *
 * The whitespace is the whole point. Testing `line.startsWith('+++')` matched
 * an added line whose own content began with `++` (`++i;`, `++count`): it was
 * dropped from the scan, and because the counter was not advanced with it,
 * every following line in that hunk was reported one number too low.
 */
const FILE_HEADER = /^(?:---|\+\+\+)(?:\s|$)/;

/** Git metadata emitted before the first hunk of a patch. */
const GIT_METADATA =
  /^(?:diff |index |old mode|new mode|similarity |dissimilarity |rename |copy |new file|deleted file|Binary files )/;

/**
 * Walk a unified diff once and return every line that exists on the new side.
 *
 * Header recognition is restricted to the region before the first `@@`, which
 * is the only place a header can legally appear. Inside a hunk every line is
 * content, so a diff of a diff — a patch file checked into the repository, a
 * fixture, a snippet in a markdown code block — is read as the source text it
 * is rather than being partly eaten as metadata.
 */
export function parseUnifiedPatch(patch: string): ParsedPatch {
  if (!patch) return { lines: [], hunkCount: 0 };

  const lines: DiffLine[] = [];
  let newLine = 0;
  let inHunk = false;
  let hunkCount = 0;

  // A trailing newline would otherwise yield a spurious empty final entry.
  const body = patch.endsWith('\n') ? patch.slice(0, -1) : patch;

  for (const raw of body.split('\n')) {
    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      inHunk = true;
      hunkCount += 1;
      continue;
    }

    if (!inHunk && (FILE_HEADER.test(raw) || GIT_METADATA.test(raw))) {
      continue;
    }

    // "\ No newline at end of file" is a note about the line above it, not a
    // line of its own. It carries no number and must not advance the counter.
    if (raw.startsWith('\\')) continue;

    if (raw.startsWith('+')) {
      lines.push({ number: newLine, content: raw.slice(1), kind: 'added' });
      newLine += 1;
      continue;
    }

    if (raw.startsWith('-')) {
      // Removed from the new file, so it consumes no new-file line number.
      continue;
    }

    if (raw.startsWith(' ')) {
      lines.push({ number: newLine, content: raw.slice(1), kind: 'context' });
      newLine += 1;
      continue;
    }

    if (raw === '') {
      // A context line whose leading space was stripped — any
      // trailing-whitespace normaliser between git and us produces these.
      // Treating it as "not a line" desynchronises everything after it, which
      // is precisely the drift this module exists to remove.
      lines.push({ number: newLine, content: '', kind: 'context' });
      newLine += 1;
    }

    // Anything else inside a hunk is unrecognised. It is deliberately dropped
    // without advancing the counter: guessing would shift every line after it.
  }

  return { lines, hunkCount };
}

/**
 * Render a parsed patch as the `<line>: <text>` block handed to the model.
 *
 * Both added and context lines are emitted. The scan prompt tells the model to
 * flag anything it can see, and a vulnerability is frequently only recognisable
 * with the surrounding lines present — but deleted lines are excluded, so a
 * finding is never raised against code the pull request removes.
 */
export function renderNumberedLines(parsed: ParsedPatch): string {
  return parsed.lines.map((line) => `${line.number}: ${line.content}`).join('\n');
}

/**
 * The new-side line numbers GitHub will accept an inline review comment on.
 *
 * GitHub only accepts a comment on a line that appears in the diff. Anchoring
 * anywhere else fails the `pulls.createReview` call — and because the review is
 * posted as a single request with every comment in it, one bad anchor loses the
 * whole batch, not just the offending comment.
 *
 * Derived from the same walk as {@link renderNumberedLines}, so a number the
 * model was shown is a number that can be looked up here.
 */
export function commentableLineNumbers(parsed: ParsedPatch): Set<number> {
  return new Set(parsed.lines.map((line) => line.number));
}

/**
 * Only the lines the pull request adds.
 *
 * Not used by the scan prompt, which wants context too, but useful for callers
 * that need to reason about what the author actually wrote.
 */
export function addedLines(parsed: ParsedPatch): DiffLine[] {
  return parsed.lines.filter((line) => line.kind === 'added');
}

/**
 * Look up the text at a new-side line number, or null when the patch does not
 * describe that line. Lets a caller confirm that a model-reported line is the
 * one it thinks it is before anchoring a comment on it.
 */
export function lineAt(parsed: ParsedPatch, number: number): DiffLine | null {
  return parsed.lines.find((line) => line.number === number) ?? null;
}
