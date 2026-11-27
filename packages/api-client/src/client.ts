import type { paths } from "./schema.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "options" | "head";

export interface ClientOptions {
  /**
   * The base URL for the SecureFlow API instance.
   * e.g., 'https://api.secureflow.dev' or 'http://localhost:9002'
   * Defaults to 'http://localhost:9002'.
   */
  baseUrl?: string;
  /**
   * Personal API token (`sft_<hex>`) or bearer token.
   * Automatically sent as `Authorization: Bearer <token>`.
   */
  token?: string;
  /**
   * Custom fetch implementation (defaults to globalThis.fetch).
   */
  fetch?: typeof fetch;
  /**
   * Default headers included on all requests.
   */
  headers?: Record<string, string>;
}

export interface RequestOptions<Params = unknown, Body = unknown> {
  params?: Params;
  body?: Body;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ApiResponse<T = unknown> {
  data: T;
  response: Response;
  status: number;
  ok: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly data: unknown;
  readonly response: Response;

  constructor(response: Response, data: unknown) {
    const errorMsg =
      (typeof data === "object" && data !== null && "error" in data
        ? String((data as any).error)
        : null) ||
      (typeof data === "object" && data !== null && "message" in data
        ? String((data as any).message)
        : null) ||
      response.statusText ||
      `Request failed with status ${response.status}`;

    super(errorMsg);
    this.name = "ApiError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.data = data;
    this.response = response;
  }
}

/**
 * Creates a fully typed SecureFlow API client.
 */
export function createSecureFlowClient(options: ClientOptions = {}) {
  const baseUrl = (options.baseUrl || "http://localhost:9002").replace(/\/+$/, "");
  const fetchFn = options.fetch || globalThis.fetch;
  const defaultHeaders = options.headers || {};

  async function request<T = unknown>(
    method: HttpMethod,
    pathPattern: string,
    opts: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    let resolvedPath = pathPattern;

    const params = (opts.params || {}) as {
      path?: Record<string, string | number>;
      query?: Record<string, string | number | boolean | undefined | null>;
    };

    // Replace path parameters, e.g. /api/findings/{id}
    if (params.path) {
      for (const [key, val] of Object.entries(params.path)) {
        resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(String(val)));
      }
    }

    // Build URL and append query parameters
    const url = new URL(`${baseUrl}${resolvedPath}`);
    if (params.query) {
      for (const [key, val] of Object.entries(params.query)) {
        if (val !== undefined && val !== null) {
          url.searchParams.append(key, String(val));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...defaultHeaders,
      ...opts.headers,
    };

    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    let bodyData: BodyInit | undefined = undefined;
    if (opts.body !== undefined) {
      if (
        typeof opts.body === "string" ||
        opts.body instanceof Blob ||
        opts.body instanceof FormData
      ) {
        bodyData = opts.body;
      } else {
        bodyData = JSON.stringify(opts.body);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    const response = await fetchFn(url.toString(), {
      method: method.toUpperCase(),
      headers,
      body: bodyData,
      signal: opts.signal,
    });

    let data: any = null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    } else {
      try {
        data = await response.text();
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      throw new ApiError(response, data);
    }

    return {
      data,
      response,
      status: response.status,
      ok: response.ok,
    };
  }

  return {
    baseUrl,
    request,

    // Convenience methods
    get: <P extends keyof paths>(path: P, opts?: RequestOptions) =>
      request("get", path as string, opts),
    post: <P extends keyof paths>(path: P, opts?: RequestOptions) =>
      request("post", path as string, opts),
    put: <P extends keyof paths>(path: P, opts?: RequestOptions) =>
      request("put", path as string, opts),
    patch: <P extends keyof paths>(path: P, opts?: RequestOptions) =>
      request("patch", path as string, opts),
    delete: <P extends keyof paths>(path: P, opts?: RequestOptions) =>
      request("delete", path as string, opts),
  };
}

export type SecureFlowClient = ReturnType<typeof createSecureFlowClient>;
