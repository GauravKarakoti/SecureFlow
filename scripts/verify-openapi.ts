/**
 * OpenAPI Synchronization Verification Script (#1097)
 * Ensures openapi.yaml exists and documents every route handler under src/app/api.
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

export function verifyOpenApiSync(options: { cwd?: string; exitOnError?: boolean } = {}): boolean {
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

  const apiDir = path.join(path.dirname(openApiFilePath), "src", "app", "api");
  const documented = documentedPaths(openApiContent);
  const undocumented = listApiRoutes(apiDir).filter((route) => !documented.has(route));
  if (undocumented.length > 0) {
    console.error(
      `❌ Error: openapi.yaml does not document ${undocumented.length} API route(s):\n` +
        undocumented.map((route) => `   - ${route}`).join("\n"),
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
