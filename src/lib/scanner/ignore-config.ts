/**
 * Where a scan's ignore configuration comes from.
 *
 * `.secureflowignore` decides what the scanner does not read: a path matching a
 * pattern is skipped outright, and the pull request still gets a clean report.
 * The `[placeholders]` section does the same for findings. Both weaken the gate,
 * so they must come from a place the author of the change under review cannot
 * write to.
 *
 * They used to be read at the pull request's *head* commit, which is the
 * author's own branch. A pull request that adds a `.secureflowignore`
 * containing `**` therefore had every file in it skipped, `.env` included, and
 * the check run came back green. The author needed no special access to do it:
 * the file is part of the diff being scanned.
 *
 * The configuration is now read from the pull request's *base* branch. Changing
 * it takes a merge through whatever review protects that branch, which is the
 * same trust anchor `CODEOWNERS` and branch protection rules use. A pull request
 * that edits `.secureflowignore` is still scanned under the old rules and the
 * new ones apply to later pull requests.
 *
 * Every failure here resolves to *no ignore rules* rather than an error. That is
 * the safe direction: not knowing what to skip means scanning more, never less.
 */

import { parseSecureFlowIgnore, type SecureFlowIgnoreConfig } from "@/lib/armor/scanner";

export const SECUREFLOW_IGNORE_FILE = ".secureflowignore";

/** The slice of an Octokit client these helpers use. */
export interface IgnoreConfigClient {
  rest: {
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => Promise<{ data: unknown }>;
    };
    pulls: {
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{ data: { base?: { ref?: string | null } | null } }>;
    };
  };
}

/** A fresh object each time, so a caller that mutates the result cannot affect the next. */
function noIgnoreConfig(): SecureFlowIgnoreConfig {
  return { ignoredPaths: [], placeholders: [] };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The name of the branch a pull request merges into, or `null` when it cannot
 * be determined.
 */
export async function resolveBaseRef(
  client: IgnoreConfigClient,
  args: { owner: string; repo: string; prNumber: number },
): Promise<string | null> {
  try {
    const { data } = await client.rest.pulls.get({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.prNumber,
    });
    const ref = data?.base?.ref;
    return typeof ref === "string" && ref !== "" ? ref : null;
  } catch (error) {
    console.warn(
      `[IgnoreConfig] Could not look up the base branch of ${args.owner}/${args.repo}#${args.prNumber}: ${describeError(error)}`,
    );
    return null;
  }
}

/**
 * The ignore configuration committed to `baseRef`.
 *
 * A repository without the file is the common case and is not worth a log line.
 * Any other failure (rate limit, outage, a permission gap) is logged, because it
 * silently changes what the scan covers.
 */
export async function loadBaseIgnoreConfig(
  client: IgnoreConfigClient,
  args: { owner: string; repo: string; baseRef: string },
): Promise<SecureFlowIgnoreConfig> {
  try {
    const { data } = await client.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: SECUREFLOW_IGNORE_FILE,
      ref: args.baseRef,
    });

    // A directory of that name comes back as an array, and only a file has `content`.
    if (!data || typeof data !== "object" || Array.isArray(data)) return noIgnoreConfig();

    const { content } = data as { content?: unknown };
    if (typeof content !== "string") return noIgnoreConfig();

    return parseSecureFlowIgnore(Buffer.from(content, "base64").toString("utf8"));
  } catch (error) {
    if (!isNotFound(error)) {
      console.warn(
        `[IgnoreConfig] Could not read ${SECUREFLOW_IGNORE_FILE} from ${args.owner}/${args.repo}@${args.baseRef}; scanning without ignore rules: ${describeError(error)}`,
      );
    }
    return noIgnoreConfig();
  }
}

/**
 * The ignore configuration a scan of this pull request should honour.
 *
 * `baseRef` is taken from the caller when it already has it (the webhook payload
 * names the base branch) and looked up from the pull request otherwise.
 */
export async function loadTrustedIgnoreConfig(
  client: IgnoreConfigClient,
  args: { owner: string; repo: string; prNumber: number; baseRef?: string | null },
): Promise<SecureFlowIgnoreConfig> {
  const baseRef = args.baseRef || (await resolveBaseRef(client, args));

  if (!baseRef) {
    console.warn(
      `[IgnoreConfig] No trusted ref for ${args.owner}/${args.repo}#${args.prNumber}; scanning without ignore rules.`,
    );
    return noIgnoreConfig();
  }

  return loadBaseIgnoreConfig(client, { owner: args.owner, repo: args.repo, baseRef });
}
