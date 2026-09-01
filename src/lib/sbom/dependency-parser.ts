import { Dependency } from '@/types/sbom';

/**
 * Parses a package.json file content to extract dependencies.
 */
function parsePackageJson(content: string, filePath: string): Dependency[] {
  try {
    const parsed = JSON.parse(content);
    const deps: Dependency[] = [];

    const allDeps = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const [name, version] of Object.entries(allDeps)) {
      if (typeof version === 'string') {
        deps.push({
          name,
          version: version.replace(/^[^\d]/, ''), // Strip ^ or ~
          manifestFile: filePath,
          ecosystem: 'npm'
        });
      }
    }
    return deps;
  } catch (error) {
    console.error(`[SBOM] Failed to parse ${filePath}:`, error);
    return [];
  }
}

/**
 * Parses a requirements.txt file content to extract dependencies.
 */
function parseRequirementsTxt(content: string, filePath: string): Dependency[] {
  const deps: Dependency[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Basic parsing for ==, >=, <=, ~=
    const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([=<>~!]+)?\s*([0-9.a-zA-Z-]+)?/);
    if (match) {
      deps.push({
        name: match[1].toLowerCase(),
        version: match[3] || 'unknown',
        manifestFile: filePath,
        ecosystem: 'pypi'
      });
    }
  }
  return deps;
}

/**
 * Main parser function that routes to the correct parser based on file extension.
 */
export function parseManifestFile(content: string, filePath: string): Dependency[] {
  if (filePath.endsWith('package.json')) {
    return parsePackageJson(content, filePath);
  }
  if (filePath.endsWith('requirements.txt')) {
    return parseRequirementsTxt(content, filePath);
  }
  // Extendable for pom.xml, Gemfile, etc.
  return [];
}
