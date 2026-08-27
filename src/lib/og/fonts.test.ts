import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ORBITRON_BOLD,
  ORBITRON_REGULAR,
  defaultFontPaths,
  fontCacheSize,
  loadFont,
  loadOrbitron,
  resetFontCache,
  type FontLoaderDeps,
} from './fonts';

afterEach(() => {
  resetFontCache();
  vi.restoreAllMocks();
});

/** A deps bundle whose disk always answers, so nothing reaches the network. */
function diskDeps(overrides: Partial<FontLoaderDeps> = {}): FontLoaderDeps {
  return {
    readFile: vi.fn(async () => Buffer.from('font-bytes')),
    fetch: vi.fn(async () => new Response('should not be reached', { status: 500 })),
    resolvePaths: (fileName) => [`/app/public/fonts/${fileName}`],
    ...overrides,
  };
}

describe('defaultFontPaths', () => {
  it('looks under public/fonts relative to the working directory first', () => {
    const [first] = defaultFontPaths('Orbitron-Bold.ttf');
    expect(first).toBe(`${process.cwd()}/public/fonts/Orbitron-Bold.ttf`);
  });

  it('offers at least one candidate for any name', () => {
    expect(defaultFontPaths('Anything.ttf').length).toBeGreaterThan(0);
  });
});

describe('loadFont reads from disk rather than over HTTP', () => {
  it('never touches the network when the file is present', async () => {
    // The bug: the primary source was `fetch(new URL('/fonts/…', req.url))`,
    // i.e. an HTTP round trip to an origin taken from the incoming request's
    // Host header, for a file that ships in this repo's `public/` directory.
    const deps = diskDeps();

    await loadFont(ORBITRON_REGULAR, deps);

    expect(deps.readFile).toHaveBeenCalledWith('/app/public/fonts/Orbitron-Regular.ttf');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('returns the file contents', async () => {
    const deps = diskDeps({ readFile: vi.fn(async () => Buffer.from('TTFDATA')) });

    const buffer = await loadFont(ORBITRON_BOLD, deps);

    expect(Buffer.from(buffer).toString()).toBe('TTFDATA');
  });

  it('copies out of Node’s shared buffer pool', async () => {
    // A small `Buffer.from` is a view into a pooled ArrayBuffer whose
    // byteLength is the pool's, not the file's. Handing that to Satori would
    // pass along whatever else the pool holds.
    const deps = diskDeps({ readFile: vi.fn(async () => Buffer.from('TTF')) });

    const buffer = await loadFont(ORBITRON_REGULAR, deps);

    expect(buffer.byteLength).toBe(3);
  });

  it('tries the next candidate path when the first is missing', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(Buffer.from('bytes'));

    const deps = diskDeps({
      readFile,
      resolvePaths: () => ['/missing/a.ttf', '/present/a.ttf'],
    });

    await loadFont(ORBITRON_REGULAR, deps);

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('treats an empty file as a miss', async () => {
    const deps = diskDeps({
      readFile: vi.fn(async () => Buffer.alloc(0)),
      fetch: vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
    });

    await loadFont(ORBITRON_REGULAR, deps);

    expect(deps.fetch).toHaveBeenCalledOnce();
  });
});

describe('the CDN fallback', () => {
  it('is used only when every disk candidate fails', async () => {
    const deps = diskDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      fetch: vi.fn(async () => new Response(new Uint8Array([9, 9]), { status: 200 })),
    });

    const buffer = await loadFont(ORBITRON_REGULAR, deps);

    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([9, 9]));
    expect(deps.fetch).toHaveBeenCalledWith(ORBITRON_REGULAR.cdnUrl);
  });

  it('is a fixed URL, never anything derived from a request', async () => {
    const requested: string[] = [];
    const deps = diskDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response(new Uint8Array([1]), { status: 200 });
      }),
    });

    await loadOrbitron(deps);

    expect(requested).toHaveLength(2);
    for (const url of requested) {
      expect(url.startsWith('https://fonts.gstatic.com/')).toBe(true);
    }
  });

  it('reports both failures when the CDN is down too', async () => {
    const deps = diskDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT');
      }),
      fetch: vi.fn(async () => new Response('nope', { status: 503 })),
    });

    await expect(loadFont(ORBITRON_REGULAR, deps)).rejects.toThrow(/Orbitron-Regular\.ttf/);
    await expect(loadFont(ORBITRON_REGULAR, deps)).rejects.toThrow(/503/);
  });
});

describe('caching', () => {
  it('reads each font once per process, not once per request', async () => {
    // The route paid two HTTP round trips on every single render.
    const deps = diskDeps();

    await loadOrbitron(deps);
    await loadOrbitron(deps);
    await loadOrbitron(deps);

    expect(deps.readFile).toHaveBeenCalledTimes(2);
    expect(fontCacheSize()).toBe(2);
  });

  it('returns identical bytes on a cache hit', async () => {
    const deps = diskDeps();

    const first = await loadFont(ORBITRON_BOLD, deps);
    const second = await loadFont(ORBITRON_BOLD, deps);

    expect(second).toBe(first);
  });

  it('de-duplicates concurrent loads of the same font', async () => {
    // An image route gets bursts; without caching the in-flight promise, the
    // first burst after a cold start would each start their own load.
    const deps = diskDeps();

    await Promise.all([
      loadFont(ORBITRON_REGULAR, deps),
      loadFont(ORBITRON_REGULAR, deps),
      loadFont(ORBITRON_REGULAR, deps),
    ]);

    expect(deps.readFile).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a transient outage is not permanent', async () => {
    const readFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue(Buffer.from('bytes'));

    const deps = diskDeps({
      readFile,
      fetch: vi.fn(async () => new Response('nope', { status: 503 })),
    });

    await expect(loadFont(ORBITRON_REGULAR, deps)).rejects.toThrow();
    expect(fontCacheSize()).toBe(0);

    await expect(loadFont(ORBITRON_REGULAR, deps)).resolves.toBeDefined();
    expect(fontCacheSize()).toBe(1);
  });

  it('keeps the two weights separate', async () => {
    const deps = diskDeps({
      readFile: vi.fn(async (path: string) => Buffer.from(path.includes('Bold') ? 'B' : 'R')),
    });

    const { regular, bold } = await loadOrbitron(deps);

    expect(Buffer.from(regular).toString()).toBe('R');
    expect(Buffer.from(bold).toString()).toBe('B');
  });
});

describe('the real files are where the loader looks', () => {
  it('loads both Orbitron weights off disk in this repo', async () => {
    // Guards the deployment assumption: if `public/fonts` moves, every share
    // card silently falls back to the CDN.
    const { regular, bold } = await loadOrbitron();

    expect(regular.byteLength).toBeGreaterThan(0);
    expect(bold.byteLength).toBeGreaterThan(0);
  });
});
