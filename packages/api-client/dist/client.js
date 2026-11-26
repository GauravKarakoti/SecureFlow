export class ApiError extends Error {
    status;
    statusText;
    data;
    response;
    constructor(response, data) {
        const errorMsg = (typeof data === "object" && data !== null && "error" in data
            ? String(data.error)
            : null) ||
            (typeof data === "object" && data !== null && "message" in data
                ? String(data.message)
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
export function createSecureFlowClient(options = {}) {
    const baseUrl = (options.baseUrl || "http://localhost:9002").replace(/\/+$/, "");
    const fetchFn = options.fetch || globalThis.fetch;
    const defaultHeaders = options.headers || {};
    async function request(method, pathPattern, opts = {}) {
        let resolvedPath = pathPattern;
        const params = (opts.params || {});
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
        const headers = {
            Accept: "application/json",
            ...defaultHeaders,
            ...opts.headers,
        };
        if (options.token) {
            headers.Authorization = `Bearer ${options.token}`;
        }
        let bodyData = undefined;
        if (opts.body !== undefined) {
            if (typeof opts.body === "string" || opts.body instanceof Blob || opts.body instanceof FormData) {
                bodyData = opts.body;
            }
            else {
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
        let data = null;
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            try {
                data = await response.json();
            }
            catch {
                data = null;
            }
        }
        else {
            try {
                data = await response.text();
            }
            catch {
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
        get: (path, opts) => request("get", path, opts),
        post: (path, opts) => request("post", path, opts),
        put: (path, opts) => request("put", path, opts),
        patch: (path, opts) => request("patch", path, opts),
        delete: (path, opts) => request("delete", path, opts),
    };
}
//# sourceMappingURL=client.js.map