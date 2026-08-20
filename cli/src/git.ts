/**
 * Git access for the pre-commit hook.
 *
 * The one thing this module exists to get right: a pre-commit hook must check
 * **staged content**, not what happens to be on disk. The previous
 * implementation asked git for the staged *paths* and then read those paths
 * from the working tree, which is a different thing and lets a secret through:
 *
 *     echo 'console.log(process.env.AWS_SECRET_ACCESS_KEY);' >> src/debug.ts
 *     git add src/debug.ts        # the secret is staged
 *     sed -i '' '$d' src/debug.ts # tidy the working tree, forget to re-stage
 *     git commit -m "wip"         # ✅ SecureFlow scan passed.
 *
 * The commit contains the logged secret; the scanner read the clean working
 * tree. "Stage a chunk, keep editing" is the ordinary `git add -p` workflow, so
 * this is not a corner case, and it fails in the direction that lets secrets
 * through (#593).
 *
 * The inverse is just as bad: unstaged debug code blocks a commit that does not
 * contain it, which teaches people to reach for `--no-verify`.
 */

import { execFileSync } from 'child_process';

/**
 * Buffer ceiling for git output.
 *
 * `execSync` defaults to 1 MB. A commit touching enough files overflowed it,
 * and the catch block then printed "Are you in a git repository?" — which was
 * not the problem, and blocked the commit for a reason nobody could act on.
 */
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

/** A problem with the repository or the git invocation, not with the content. */
export class GitError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GitError';
  }
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf-8',
    maxBuffer: MAX_GIT_BUFFER,
  });
}

/** Whether the current directory is inside a work tree. */
export function isGitRepository(): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Paths staged for commit.
 *
 * `-z` is what makes this correct for real repositories. Without it git honours
 * `core.quotePath`, which defaults to **true**, so a staged `src/café.ts` comes
 * back as the literal 15 characters `"src/caf\303\251.ts"` — quotes and octal
 * escapes included. `path.resolve` then built a path that does not exist,
 * `existsSync` returned false, and the file was skipped with no warning and no
 * non-zero exit. The same applied to any path containing a space or a `"`.
 *
 * `--diff-filter=ACMR` drops deletions, which have no staged content to read,
 * and keeps renames, which do.
 */
export function getStagedFiles(): string[] {
  let output: string;

  try {
    output = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  } catch (error) {
    throw new GitError(
      isGitRepository()
        ? 'Could not list staged files. `git diff --cached` failed.'
        : 'Not a git repository (or git is not on PATH).',
      error,
    );
  }

  // NUL-separated, with a trailing separator on a non-empty list.
  return output.split('\u0000').filter((entry) => entry.length > 0);
}

/**
 * The staged content of `path` — the bytes that will actually be committed.
 *
 * `git show :<path>` reads the index entry, which is the whole point. Returns
 * null when the blob cannot be read (a conflicted entry, a submodule pointer,
 * a symlink), so the caller can report it rather than treat it as clean.
 */
export function readStagedContent(path: string): string | null {
  try {
    return git(['show', `:${path}`]);
  } catch {
    return null;
  }
}
