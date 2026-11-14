import { vi } from "vitest";

export class NextRequest extends Request {
  readonly nextUrl: URL;
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    this.nextUrl = new URL(urlStr);
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
}
