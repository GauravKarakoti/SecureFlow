/**
 * GitHub App credentials, in a module every caller can reach.
 *
 * These lived in `@/lib/queue/worker`, which imports the webhook and SBOM
 * helpers it drives. Anything those helpers need has to sit below them, or the
 * import graph loops back on itself — so the App credentials live here and
 * `worker.ts` re-exports them for its existing callers.
 */

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

/**
 * Read and validate the GitHub App credentials.
 *
 * The previous `process.env.GITHUB_PRIVATE_KEY!.replace(...)` produced
 * "Cannot read properties of undefined (reading 'replace')" when the variable
 * was unset — a misleading error for a straightforward misconfiguration.
 */
export function getGitHubAppCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { appId: string; privateKey: string } {
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

  // Keys are commonly stored with literal "\n" sequences in a single-line env var.
  return { appId, privateKey: rawPrivateKey.replace(/\\n/g, "\n") };
}
