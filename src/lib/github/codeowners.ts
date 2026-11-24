const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;
const MAX_BYTES = 3_000_000;
const VALID_OWNER =
  /^(?:@[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9_-]*)?|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z0-9-]+)$/i;

export interface CodeOwnerRule {
  readonly segments: readonly string[];
  readonly directoryOnly: boolean;
  readonly owners: readonly string[];
}

type ContentsParams = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
  headers: { accept: string };
  request: { signal: AbortSignal };
};

export interface CodeOwnersClient {
  rest: { repos: { getContent(args: ContentsParams): Promise<{ data: unknown }> } };
}

export interface CodeOwnersBase {
  owner: string;
  repo: string;
  baseRef: string | null | undefined;
}

/** Parse the supported, case-sensitive subset of GitHub CODEOWNERS rules. */
export function parseCodeOwners(text: string): CodeOwnerRule[] {
  if (Buffer.byteLength(text) >= MAX_BYTES || text.includes("\0")) return [];

  const rules: CodeOwnerRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const raw = parts.shift() ?? "";
    if (!raw || raw.startsWith("#") || raw.startsWith("!") || /[\[\]\\]/.test(raw)) continue;
    const directoryOnly = raw.endsWith("/");
    const pattern = raw.replace(/^\//, "").replace(/\/$/, "");
    const segments = pattern.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) continue;

    const commentIndex = parts.findIndex((part) => part.startsWith("#"));
    const owners = commentIndex < 0 ? parts : parts.slice(0, commentIndex);
    if (owners.some((owner) => !VALID_OWNER.test(owner))) continue;
    if (!raw.startsWith("/") && segments.length === 1 && pattern !== "**") {
      segments.unshift("**");
    }
    rules.push({ segments, directoryOnly, owners: [...new Set(owners)] });
  }
  return rules;
}

/** Match a wildcard within one segment, without backtracking through a regex. */
function matchesSegment(pattern: string, value: string): boolean {
  let token = 0;
  let character = 0;
  let star = -1;
  let reopen = 0;
  while (character < value.length) {
    if (pattern[token] === "*") {
      star = token++;
      reopen = character;
    } else if (pattern[token] === "?" || pattern[token] === value[character]) {
      token++;
      character++;
    } else if (star >= 0) {
      token = star + 1;
      character = ++reopen;
    } else {
      return false;
    }
  }
  while (pattern[token] === "*") token++;
  return token === pattern.length;
}

function matchesRule({ segments, directoryOnly }: CodeOwnerRule, path: string[]): boolean {
  const limit = path.length;
  let reachable = new Uint8Array(limit + 1);
  reachable[0] = 1;
  for (const [index, pattern] of segments.entries()) {
    const next = new Uint8Array(limit + 1);
    if (pattern === "**") {
      // A trailing globstar matches something inside its parent directory.
      const minimum = index > 0 && index === segments.length - 1 ? 1 : 0;
      let canReach = false;
      for (let i = minimum; i <= limit; i++) {
        canReach ||= reachable[i - minimum] === 1;
        next[i] = canReach ? 1 : 0;
      }
    } else {
      for (let i = 0; i < limit; i++) {
        if (reachable[i] && matchesSegment(pattern, path[i])) next[i + 1] = 1;
      }
    }
    if (!next.includes(1)) return false;
    reachable = next;
  }

  const last = segments[segments.length - 1];
  if (directoryOnly) return reachable.subarray(1, limit).includes(1);
  if (!last.includes("*") && !last.includes("?")) return reachable.subarray(1).includes(1);
  return reachable[limit] === 1;
}

export function ownersForPath(
  rules: readonly CodeOwnerRule[],
  filePath: string,
): readonly string[] {
  const segments = filePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return [];
  for (let index = rules.length - 1; index >= 0; index--) {
    if (matchesRule(rules[index], segments)) return rules[index].owners;
  }
  return [];
}

/** Read the first CODEOWNERS file present at the supplied base revision. */
export async function loadBaseCodeOwners(
  client: CodeOwnersClient,
  { owner, repo, baseRef }: CodeOwnersBase,
): Promise<CodeOwnerRule[] | null> {
  if (!baseRef) return null;
  const signal = AbortSignal.timeout(5000);
  for (const path of LOCATIONS) {
    try {
      const { data } = await client.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: baseRef,
        headers: { accept: "application/vnd.github.raw+json" },
        request: { signal },
      });
      const text =
        data instanceof ArrayBuffer && data.byteLength < MAX_BYTES
          ? new TextDecoder("utf-8", { fatal: true }).decode(data)
          : data;
      if (typeof text !== "string") return null;
      const rules = parseCodeOwners(text);
      return rules.length ? rules : null;
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 404) {
        continue;
      }
      return null;
    }
  }
  return null;
}
