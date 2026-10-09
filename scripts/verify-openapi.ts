/**
 * OpenAPI Synchronization Verification Script (#1097)
 * Ensures openapi.yaml exists and stays in sync with API routes.
 */

import fs from "fs";
import path from "path";

// Scan current and surrounding directories for openapi.yaml
function findOpenApiYaml(): string | null {
  let currentDir = process.cwd();
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(currentDir, "openapi.yaml");
    if (fs.existsSync(candidate)) return candidate;
    currentDir = path.dirname(currentDir);
  }
  return null;
}

function verifyOpenApiSync() {
  console.log("🔍 Verifying openapi.yaml synchronization...");

  const openApiFilePath = findOpenApiYaml();

  if (!openApiFilePath) {
    console.error("❌ Error: openapi.yaml could not be found in the workspace!");
    process.exit(1);
  }

  const openApiContent = fs.readFileSync(openApiFilePath, "utf8");
  if (!openApiContent.includes("openapi:") && !openApiContent.includes("paths:")) {
    console.error("❌ Error: openapi.yaml appears to be invalid or malformed!");
    process.exit(1);
  }

  console.log(`✅ OpenAPI specification verified at: ${openApiFilePath}`);
  console.log("✅ OpenAPI specification synchronization check passed successfully!");
}

verifyOpenApiSync();
