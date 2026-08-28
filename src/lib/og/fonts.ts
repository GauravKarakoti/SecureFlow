/**
 * Font loading for the OG image routes (#687).
 *
 * `/api/og/heist` loaded both Orbitron weights like this, on every request:
 *
 *     const originUrl = new URL(`/fonts/${fontFileName}`, req.url);
 *     const res = await fetch(originUrl.href);
 *
 * Two separate problems.
 *
 * **The origin came from the request.** `req.url` is assembled from the
 * incoming request, so its authority reflects the `Host` header the caller
 * sent. Behind any proxy that does not pin `Host`, that turns a public
 * unauthenticated endpoint into a server-side fetch to a host the caller names,
 * whose response bytes are then handed to the font parser. This repo already
 * treats that shape as a defect: `src/lib/queue/outbound-dispatch.ts` exists
 * (#642) precisely because a worker "will connect to whatever address a job
 * names".
 *
 * **Nothing was cached.** The files are static assets that ship in `public/`,
 * and every render paid two full HTTP round trips plus two `ArrayBuffer`
 * allocations before Satori was even invoked. Every crawler hit, every Slack or
 * Discord unfurl, and every legitimate share view paid it.
 *
 * The fix is both halves of the obvious one: read the file off local disk, and
 * keep it. Fonts do not change between requests, so the first render of a
 * process pays for them and no other render does.
 *
 * The CDN fallback is kept as a last resort — the standalone Docker build is
 * expected to carry `public/`, but a deployment that somehow does not should
 * degrade to a slow card rather than a 500.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A font this module knows how to load. */
export interface FontAsset {
  /** File name under `public/fonts`. */
  fileName: string;
  /** Where to look if the file is not on disk. */
  cdnUrl: string;
}

export const ORBITRON_REGULAR: FontAsset = {
  fileName: 'Orbitron-Regular.ttf',
  cdnUrl: 'https://fonts.gstatic.com/s/orbitron/v31/yDirect4mAydbld1e65dqv248s.ttf',
};

export const ORBITRON_BOLD: FontAsset = {
  fileName: 'Orbitron-Bold.ttf',
  cdnUrl: 'https://fonts.gstatic.com/s/orbitron/v31/yDirect4mAydbld1e65bvq8.ttf',
};

/**
 * Seams for the tests, so no test needs a real filesystem or a real socket.
 */
export interface FontLoaderDeps {
  readFile: (path: string) => Promise<Buffer>;
  fetch: typeof fetch;
  /** Candidate on-disk paths, most likely first. */
  resolvePaths: (fileName: string) => string[];
}

/**
 * Where `public/fonts/<name>` can be found from a running server.
 *
 * `process.cwd()` covers `next start` and the standalone output, both of which
 * run with the project root as the working directory. The `import.meta.url`
 * walk covers a bundle executed from somewhere else — it is the same fallback
 * the route used to carry, minus the `fetch()` wrapper around a `file:` URL.
 */
export function defaultFontPaths(fileName: string): string[] {
  const paths = [join(process.cwd(), 'public', 'fonts', fileName)];

  try {
    paths.push(fileURLToPath(new URL(`../../../public/fonts/${fileName}`, import.meta.url)));
  } catch {
    // `import.meta.url` is not a file URL under some bundlers. The cwd path and
    // the CDN fallback still apply.
  }

  return paths;
}

const defaultDeps: FontLoaderDeps = {
  readFile: (path) => readFile(path),
  fetch: (...args) => fetch(...args),
  resolvePaths: defaultFontPaths,
};

/**
 * Resolved fonts, and the in-flight promises for the ones still resolving.
 *
 * Caching the *promise* rather than only the result matters: an image route
 * gets concurrent requests, and without it the first burst after a cold start
 * would each start their own load.
 */
const cache = new Map<string, Promise<ArrayBuffer>>();

/** Number of fonts currently held. Test seam and diagnostics. */
export function fontCacheSize(): number {
  return cache.size;
}

/** Drop everything cached. Test seam. */
export function resetFontCache(): void {
  cache.clear();
}

async function load(asset: FontAsset, deps: FontLoaderDeps): Promise<ArrayBuffer> {
  const failures: string[] = [];

  for (const path of deps.resolvePaths(asset.fileName)) {
    try {
      const buffer = await deps.readFile(path);
      if (buffer.byteLength > 0) {
        // `slice()` copies out of Node's shared pool allocator. Handing the
        // pooled ArrayBuffer straight to Satori would expose whatever else the
        // pool holds, and its byteLength is the pool's, not the file's.
        return buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength
        ) as ArrayBuffer;
      }
      failures.push(`${path}: empty`);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Last resort. The URL is a constant, not anything derived from a request.
  const response = await deps.fetch(asset.cdnUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to load font ${asset.fileName} (disk: ${failures.join('; ') || 'no candidates'}; ` +
        `cdn: HTTP ${response.status})`
    );
  }

  return response.arrayBuffer();
}

/**
 * The bytes of `asset`, loaded once per process.
 *
 * A failed load is not cached, so a transient CDN outage during a cold start
 * does not permanently break the route for the life of the process.
 */
export function loadFont(
  asset: FontAsset,
  deps: FontLoaderDeps = defaultDeps
): Promise<ArrayBuffer> {
  const cached = cache.get(asset.fileName);
  if (cached) return cached;

  const pending = load(asset, deps).catch((error) => {
    cache.delete(asset.fileName);
    throw error;
  });

  cache.set(asset.fileName, pending);
  return pending;
}

/** Both Orbitron weights, in the order `ImageResponse` wants them. */
export async function loadOrbitron(
  deps: FontLoaderDeps = defaultDeps
): Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> {
  const [regular, bold] = await Promise.all([
    loadFont(ORBITRON_REGULAR, deps),
    loadFont(ORBITRON_BOLD, deps),
  ]);

  return { regular, bold };
}
