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
export declare class ApiError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly data: unknown;
    readonly response: Response;
    constructor(response: Response, data: unknown);
}
/**
 * Creates a fully typed SecureFlow API client.
 */
export declare function createSecureFlowClient(options?: ClientOptions): {
    baseUrl: string;
    request: <T = unknown>(method: HttpMethod, pathPattern: string, opts?: RequestOptions) => Promise<ApiResponse<T>>;
    get: <P extends keyof paths>(path: P, opts?: RequestOptions) => Promise<ApiResponse<unknown>>;
    post: <P extends keyof paths>(path: P, opts?: RequestOptions) => Promise<ApiResponse<unknown>>;
    put: <P extends keyof paths>(path: P, opts?: RequestOptions) => Promise<ApiResponse<unknown>>;
    patch: <P extends keyof paths>(path: P, opts?: RequestOptions) => Promise<ApiResponse<unknown>>;
    delete: <P extends keyof paths>(path: P, opts?: RequestOptions) => Promise<ApiResponse<unknown>>;
};
export type SecureFlowClient = ReturnType<typeof createSecureFlowClient>;
//# sourceMappingURL=client.d.ts.map