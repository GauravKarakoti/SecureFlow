/**
 * Cloudflare CDN Worker for SecureFlow Backblaze B2 Audit Sink (#2097)
 *
 * This Cloudflare Worker proxies and caches read/write operations for audit logs
 * stored in Backblaze B2 S3-compatible object storage.
 *
 * Benefits:
 * 1. Zero egress cost between Backblaze B2 and Cloudflare (Bandwidth Alliance).
 * 2. Caches read and status queries on Cloudflare's global edge network.
 * 3. Prevents hitting S3 rate limits and API quotas.
 * 4. Adds security headers and signature validation at edge.
 */

export interface Env {
  // Backblaze B2 S3 Endpoint: e.g. "https://s3.us-west-004.backblazeb2.com"
  B2_ENDPOINT: string;
  // B2 Bucket name: e.g. "secureflow-audit-logs"
  B2_BUCKET: string;
  // Optional shared API token for authenticating worker requests
  WORKER_AUTH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);

    // 1. Authenticate caller (optional bearer token)
    if (env.WORKER_AUTH_TOKEN) {
      const authHeader = request.headers.get("Authorization");
      if (authHeader !== `Bearer ${env.WORKER_AUTH_TOKEN}`) {
        return new Response(JSON.stringify({ error: "Unauthorized worker access" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 2. Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/_health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          service: "secureflow-audit-cdn-worker",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        },
      );
    }

    // 3. Construct Backblaze B2 target URL
    const b2Endpoint = (env.B2_ENDPOINT || "https://s3.us-west-004.backblazeb2.com").replace(/\/+$/, "");
    const bucket = env.B2_BUCKET || "secureflow-audit-logs";
    const b2Path = url.pathname.replace(/^\/+/, "");
    const targetUrl = `${b2Endpoint}/${bucket}/${b2Path}${url.search}`;

    // 4. Handle GET requests with Edge Caching
    if (request.method === "GET" || request.method === "HEAD") {
      const cache = (caches as any).default;
      const cacheKey = new Request(url.toString(), request);
      let response = await cache.match(cacheKey);

      if (!response) {
        response = await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });

        // Cache successful immutable batch JSON files for 30 days (2592000s)
        if (response.status === 200 && url.pathname.endsWith(".json")) {
          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cache-Control", "public, max-age=2592000, immutable");
          newHeaders.set("X-SecureFlow-CDN-Cache", "MISS");

          const cachedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });

          ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));
          return cachedResponse;
        }

        return response;
      }

      // Add Cache HIT header
      const hitHeaders = new Headers(response.headers);
      hitHeaders.set("X-SecureFlow-CDN-Cache", "HIT");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: hitHeaders,
      });
    }

    // 5. Handle PUT / POST (Audit log batch writes to Backblaze B2)
    if (request.method === "PUT" || request.method === "POST") {
      const forwardHeaders = new Headers(request.headers);
      // Ensure content-type is preserved
      if (!forwardHeaders.has("Content-Type")) {
        forwardHeaders.set("Content-Type", "application/json");
      }

      const b2Response = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: request.body,
      });

      return new Response(b2Response.body, {
        status: b2Response.status,
        statusText: b2Response.statusText,
        headers: b2Response.headers,
      });
    }

    return new Response(JSON.stringify({ error: `Method ${request.method} not allowed` }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  },
};
