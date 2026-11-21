import cliPackageJson from "../../cli/package.json";

export interface VersionInfo {
  version: string;
  commit: string;
  buildDate: string;
}

/**
 * Returns sanitized version information about the running SecureFlow instance.
 * Exposes the CLI / engine release version (which has incremental versioning),
 * commit SHA, and build date.
 * Guaranteed to exclude internal paths, dependency lists, and sensitive configuration.
 */
export function getVersionInfo(): VersionInfo {
  const version =
    process.env.APP_VERSION ||
    process.env.NEXT_PUBLIC_APP_VERSION ||
    process.env.CLI_VERSION ||
    process.env.NEXT_PUBLIC_CLI_VERSION ||
    cliPackageJson.version ||
    "3.8.0";

  const commit =
    process.env.GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.COMMIT_REF ||
    process.env.RENDER_GIT_COMMIT ||
    "development";

  const buildDate =
    process.env.BUILD_DATE ||
    process.env.NEXT_PUBLIC_BUILD_DATE ||
    "unknown";

  return {
    version: String(version).trim(),
    commit: String(commit).trim(),
    buildDate: String(buildDate).trim(),
  };
}
