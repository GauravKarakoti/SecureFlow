/**
 * GitHub App credentials and client creation, in a module every caller can reach.
 *
 * These lived in `@/lib/queue/worker`, which imports the webhook and SBOM
 * helpers it drives. Anything those helpers need has to sit below them, or the
 * import graph loops back on itself — so the App credentials live here and
 * `worker.ts` re-exports them for its existing callers.
 */

import { App, Octokit } from "octokit";

/**
 * A problem with the deployment itself rather than with the delivery.
 *
 * Retrying cannot help — the same missing variable will still be missing — so
 * this is thrown with a message that names the variable instead of surfacing as
 * a confusing dereference error three attempts later.
 */
export class WebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigurationError";
  }
}

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
export const DEFAULT_GITHUB_WEB_URL = "https://github.com";

/**
 * Resolve and validate the GitHub API base URL.
 *
 * Defaults to `https://api.github.com` for github.com users.
 * For GitHub Enterprise Server instances, points to `https://ghe.mycorp.com/api/v3`.
 * Enforces HTTPS in production mode (`NODE_ENV === "production"`).
 */
export function getGitHubApiUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const rawApiUrl = env.GITHUB_API_URL?.trim() || DEFAULT_GITHUB_API_URL;

  let parsed: URL;
  try {
    parsed = new URL(rawApiUrl);
  } catch {
    throw new WebhookConfigurationError(`Invalid GITHUB_API_URL: "${rawApiUrl}"`);
  }

  const isProduction = (env.NODE_ENV ?? process.env.NODE_ENV) === "production";
  if (isProduction && parsed.protocol !== "https:") {
    throw new WebhookConfigurationError("GITHUB_API_URL must use HTTPS in production.");
  }

  return rawApiUrl.replace(/\/+$/, "");
}

/**
 * Resolve and validate the GitHub web frontend URL.
 *
 * If `GITHUB_WEB_URL` is set, it is used.
 * Otherwise, if `GITHUB_API_URL` is set to a non-default host (e.g. `https://ghe.mycorp.com/api/v3`),
 * the origin is derived (e.g. `https://ghe.mycorp.com`).
 * Defaults to `https://github.com`.
 * Enforces HTTPS in production mode (`NODE_ENV === "production"`).
 */
export function getGitHubWebUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const rawWebUrl = env.GITHUB_WEB_URL?.trim();
  const rawApiUrl = env.GITHUB_API_URL?.trim();

  let resolvedUrl: string;

  if (rawWebUrl) {
    resolvedUrl = rawWebUrl;
  } else if (rawApiUrl) {
    try {
      const parsedApi = new URL(rawApiUrl);
      if (parsedApi.hostname === "api.github.com") {
        resolvedUrl = DEFAULT_GITHUB_WEB_URL;
      } else {
        resolvedUrl = parsedApi.origin;
      }
    } catch {
      resolvedUrl = DEFAULT_GITHUB_WEB_URL;
    }
  } else {
    resolvedUrl = DEFAULT_GITHUB_WEB_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    throw new WebhookConfigurationError(`Invalid GITHUB_WEB_URL: "${resolvedUrl}"`);
  }

  const isProduction = (env.NODE_ENV ?? process.env.NODE_ENV) === "production";
  if (isProduction && parsed.protocol !== "https:") {
    throw new WebhookConfigurationError("GITHUB_WEB_URL must use HTTPS in production.");
  }

  return resolvedUrl.replace(/\/+$/, "");
}

/**
 * Read and validate the GitHub App credentials and configured URLs.
 */
export function getGitHubAppCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): {
  appId: string;
  privateKey: string;
  apiUrl: string;
  webUrl: string;
  Octokit?: typeof Octokit;
} {
  const appId = env.GITHUB_APP_ID?.trim();
  const rawPrivateKey = env.GITHUB_PRIVATE_KEY;

  if (!appId) {
    throw new WebhookConfigurationError(
      "GITHUB_APP_ID is not set; cannot authenticate as the GitHub App.",
    );
  }
  if (!rawPrivateKey || rawPrivateKey.trim() === "") {
    throw new WebhookConfigurationError(
      "GITHUB_PRIVATE_KEY is not set; cannot authenticate as the GitHub App.",
    );
  }

  const apiUrl = getGitHubApiUrl(env);
  const webUrl = getGitHubWebUrl(env);

  const customOctokit =
    typeof Octokit?.defaults === "function"
      ? Octokit.defaults({ baseUrl: apiUrl })
      : Octokit;

  // Keys are commonly stored with literal "\n" sequences in a single-line env var.
  return {
    appId,
    privateKey: rawPrivateKey.replace(/\\n/g, "\n"),
    apiUrl,
    webUrl,
    Octokit: customOctokit,
  };
}

export interface GitHubAppClientOptions {
  appId?: string;
  privateKey?: string;
  apiUrl?: string;
  baseUrl?: string;
  Octokit?: typeof Octokit;
}

/**
 * Instantiate an authenticated GitHub App client with configured API baseUrl.
 *
 * Uses Octokit.defaults({ baseUrl }) so all installation clients and API calls
 * (installation tokens, check runs, comments, reviews, files, SARIF uploads)
 * route to the configured GitHub Enterprise Server or api.github.com.
 */
export function createGitHubAppClient(
  options: GitHubAppClientOptions = {},
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): App {
  let defaultAppId: string | undefined;
  let defaultPrivateKey: string | undefined;
  let defaultApiUrl: string | undefined;

  if (!options.appId || !options.privateKey) {
    const creds = getGitHubAppCredentials(env);
    defaultAppId = creds.appId;
    defaultPrivateKey = creds.privateKey;
    defaultApiUrl = creds.apiUrl;
  } else {
    defaultApiUrl = getGitHubApiUrl(env);
  }

  const appId = options.appId ?? defaultAppId!;
  const privateKey = options.privateKey ?? defaultPrivateKey!;
  const apiUrl = options.baseUrl ?? options.apiUrl ?? defaultApiUrl!;

  const baseOctokitClass = options.Octokit ?? Octokit;
  const customOctokit =
    typeof baseOctokitClass?.defaults === "function"
      ? baseOctokitClass.defaults({ baseUrl: apiUrl })
      : baseOctokitClass;

  return new App({
    appId,
    privateKey,
    ...(customOctokit ? { Octokit: customOctokit } : {}),
  });
}
