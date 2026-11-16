import { vi } from "vitest";

export class NextRequest extends Request {
  readonly nextUrl: URL;
  readonly cookies: {
    get: (name: string) => { name: string; value: string } | undefined;
    getAll: () => Array<{ name: string; value: string }>;
    has: (name: string) => boolean;
  };

  constructor(input: RequestInfo | URL, init?: RequestInit & { duplex?: string }) {
    const isStream = init?.body instanceof ReadableStream;
    super(input, {
      ...init,
      ...(isStream && ({ duplex: "half" } as any)),
    });

    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    this.nextUrl = new URL(urlStr);

    // Parse cookie header for test request matching
    const cookieHeader = this.headers.get("cookie") || "";
    const cookieMap = new Map<string, string>();
    if (cookieHeader) {
      cookieHeader.split(";").forEach((cookie) => {
        const [key, ...v] = cookie.trim().split("=");
        if (key) {
          cookieMap.set(key, decodeURIComponent(v.join("=")));
        }
      });
    }

    this.cookies = {
      get: (name: string) => {
        const val = cookieMap.get(name);
        return val !== undefined ? { name, value: val } : undefined;
      },
      getAll: () => Array.from(cookieMap.entries()).map(([name, value]) => ({ name, value })),
      has: (name: string) => cookieMap.has(name),
    };
  }
}

export class NextResponse extends Response {
  static json = vi.fn((body: unknown, init?: ResponseInit) => {
    return new NextResponse(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers || {}),
      },
    });
  });

  static next = vi.fn((init?: ResponseInit) => {
    return new NextResponse(null, { status: 200, ...init });
  });

  static redirect = vi.fn((url: URL | string, status = 307) => {
    return new NextResponse(null, {
      status,
      headers: { Location: typeof url === "string" ? url : url.toString() },
    });
  });
}
