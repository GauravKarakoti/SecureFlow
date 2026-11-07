/**
 * OpenAPI Synchronization Verification Script (#1097, #1538)
 * Ensures openapi.yaml exists, conforms to spec, and documents every public
 * route handler under src/app/api (unless explicitly ignored in .openapiignore).
 */

import fs from "fs";
import path from "path";

// Scan current and surrounding directories for openapi.yaml
export function findOpenApiYaml(fromDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(fromDir);
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(currentDir, "openapi.yaml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

// Find optional .openapiignore file in the repository root or parent directories
export function findOpenApiIgnore(fromDir: string = process.cwd()): string | null {
  let currentDir = path.resolve(fromDir);
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(currentDir, ".openapiignore");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

// Parse an ignore list string into pattern matchers (exact paths or wildcard prefixes)
export function parseIgnoreList(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

// Test if a route matches any pattern in the ignore list
export function isRouteIgnored(route: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (pattern === route) {
      return true;
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (route === prefix || route.startsWith(prefix + "/")) {
        return true;
      }
    } else if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (route.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

// The OpenAPI path of every route handler under src/app/api: route groups `(x)` drop
// out and `[id]` becomes `{id}`. Catch-all segments (`[...nextauth]`) have no OpenAPI
// form, so those routes are skipped. A missing directory has no routes.
export function listApiRoutes(apiDir: string): string[] {
  if (!fs.existsSync(apiDir)) return [];
  const routes: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (/^route\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        if (segments.some((s) => s.startsWith("[..."))) continue;
        const parts = segments
          .filter((s) => !/^\(.*\)$/.test(s))
          .map((s) => s.replace(/^\[(.+)\]$/, "{$1}"));
        routes.push(["/api", ...parts].join("/"));
      }
    }
  };
  walk(apiDir, []);
  return routes.sort();
}

// The keys under `paths:` in the spec, read as the two-space-indented `/...:` lines.
export function documentedPaths(openApiContent: string): Set<string> {
  return new Set(Array.from(openApiContent.matchAll(/^ {2}(\/\S*):[ \t]*\r?$/gm), (m) => m[1]));
}

export function verifyOpenApiSync(
  options: { cwd?: string; exitOnError?: boolean; ignoreFile?: string } = {},
): boolean {
  console.log("🔍 Verifying openapi.yaml synchronization...");

  const openApiFilePath = findOpenApiYaml(options.cwd);

  if (!openApiFilePath) {
    console.error("❌ Error: openapi.yaml could not be found in the workspace!");
    if (options.exitOnError !== false && process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
    return false;
  }

  const openApiContent = fs.readFileSync(openApiFilePath, "utf8");
  if (!openApiContent.includes("openapi:") || !openApiContent.includes("paths:")) {
    console.error("❌ Error: openapi.yaml appears to be invalid or malformed!");
    if (options.exitOnError !== false && process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
    return false;
  }

  const rootDir = path.dirname(openApiFilePath);
  const apiDir = path.join(rootDir, "src", "app", "api");
  const documented = documentedPaths(openApiContent);

  // Load ignore patterns from options.ignoreFile or discovered .openapiignore
  let ignorePatterns: string[] = [];
  const ignoreFilePath = options.ignoreFile ?? findOpenApiIgnore(options.cwd ?? rootDir);
  if (ignoreFilePath && fs.existsSync(ignoreFilePath)) {
    ignorePatterns = parseIgnoreList(fs.readFileSync(ignoreFilePath, "utf8"));
  }

  const allRoutes = listApiRoutes(apiDir);
  const undocumented = allRoutes
    .filter((route) => !documented.has(route))
    .filter((route) => !isRouteIgnored(route, ignorePatterns));

  if (undocumented.length > 0) {
    console.error(
      `❌ Error: openapi.yaml does not document ${undocumented.length} API route(s):\n` +
        undocumented.map((route) => `   - ${route}`).join("\n") +
        `\n\nIf any of these are internal or private routes, add them to .openapiignore.`,
    );
    if (options.exitOnError !== false && process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
    return false;
  }

  console.log(`✅ OpenAPI specification verified at: ${openApiFilePath}`);
  console.log("✅ OpenAPI specification synchronization check passed successfully!");
  return true;
}

const isMain = process.argv[1] && /verify-openapi(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) {
  verifyOpenApiSync();
}
