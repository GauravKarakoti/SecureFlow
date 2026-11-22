import fs from "node:fs";

/**
 * Default list of sensitive environment variable names supported by SecureFlow.
 * Each of these variables can be configured either directly (<NAME>) or
 * via a file path (<NAME>_FILE), which is recommended in Docker Swarm and Kubernetes.
 */
export const DEFAULT_SECRET_VARS: readonly string[] = [
  "DATABASE_URL",
  "DATABASE_POOL_URL",
  "GROQ_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_CLIENT_SECRET",
  "AUTH_SECRET",
  "ARMORIQ_API_KEY",
  "ARMORIQ_PROOF_SIGNING_KEY",
  "UPSTASH_REDIS_REST_TOKEN",
  "ELEVENLABS_API_KEY",
  "BREVO_API_KEY",
  "SMTP_PASS",
  "REDIS_URL",
] as const;

/**
 * External/IDE environment variables with a `_FILE` suffix that are not application secrets
 * and may reference ephemeral files that do not exist during builds.
 */
const IGNORED_AUTO_DISCOVERED_FILE_VARS = new Set<string>(["CODELLDB_LAUNCH_CONNECT"]);

export interface ResolveSecretOptions {
  /**
   * List of base secret variable names to check (without _FILE suffix).
   * Defaults to DEFAULT_SECRET_VARS plus any *_FILE keys found in source.
   */
  secretVars?: readonly string[] | string[];
  /**
   * Custom file reader function. Defaults to fs.readFileSync(path, "utf8").
   */
  readFile?: (filePath: string) => string;
  /**
   * Whether to mutate process.env when resolving secrets.
   * Defaults to true if source === process.env, false otherwise.
   */
  mutateProcessEnv?: boolean;
}

/**
 * Trims a single trailing newline (\r?\n) from the content.
 * Preserves all internal newlines, which is essential for multi-line secrets like PEM private keys.
 */
export function trimTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

/**
 * Determines whether a string value is considered "set" (non-empty and not just whitespace).
 */
function isValueSet(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolves a single secret variable value from direct environment variable or file companion.
 *
 * Rules:
 * - If both <NAME> and <NAME>_FILE are set, throws an error naming both without logging secrets.
 * - If only <NAME>_FILE is set, reads the file, trims trailing newline, and returns value.
 * - If file is missing or unreadable, throws a readable error.
 * - If only <NAME> is set, returns its value.
 * - If neither is set, returns undefined.
 */
export function resolveSecretValue(
  name: string,
  source: Record<string, string | undefined> = process.env,
  readFile: (filePath: string) => string = (p) => fs.readFileSync(p, "utf8"),
): string | undefined {
  const fileKey = `${name}_FILE`;
  const directValue = source[name];
  const filePath = source[fileKey];

  const hasDirect = isValueSet(directValue);
  const hasFile = isValueSet(filePath);

  if (hasDirect && hasFile) {
    throw new Error(`Cannot specify both ${name} and ${fileKey}. Choose one secret source.`);
  }

  if (hasFile) {
    const trimmedPath = filePath.trim();
    try {
      const content = readFile(trimmedPath);
      return trimTrailingNewline(content);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to read secret for ${name} from ${fileKey} (${trimmedPath}): ${reason}`,
      );
    }
  }

  return hasDirect ? directValue : undefined;
}

/**
 * Resolves all configured secret variables and any discovered *_FILE variables in source.
 * Updates source in-place with resolved values.
 */
export function resolveFileSecrets<T extends Record<string, string | undefined>>(
  source: T = process.env as unknown as T,
  options?: ResolveSecretOptions,
): T {
  const customReader = options?.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const hasExplicitSecretVars = options?.secretVars !== undefined;
  const configuredVars = new Set<string>(options?.secretVars ?? DEFAULT_SECRET_VARS);

  // Discover any keys ending in _FILE in the source record
  for (const key of Object.keys(source)) {
    if (key.endsWith("_FILE") && key.length > 5) {
      const baseName = key.slice(0, -5);
      if (!hasExplicitSecretVars && IGNORED_AUTO_DISCOVERED_FILE_VARS.has(baseName)) {
        continue;
      }
      configuredVars.add(baseName);
    }
  }

  const shouldMutateProcessEnv =
    options?.mutateProcessEnv ?? source === (process.env as unknown as T);

  for (const varName of configuredVars) {
    const fileKey = `${varName}_FILE`;
    const hasFile = isValueSet(source[fileKey]);
    const hasDirect = isValueSet(source[varName]);

    if (hasDirect && hasFile) {
      throw new Error(`Cannot specify both ${varName} and ${fileKey}. Choose one secret source.`);
    }

    if (hasFile) {
      const resolved = resolveSecretValue(varName, source, customReader);
      if (resolved !== undefined) {
        (source as Record<string, string | undefined>)[varName] = resolved;
        if (shouldMutateProcessEnv) {
          process.env[varName] = resolved;
        }
      }
    }
  }

  return source;
}
