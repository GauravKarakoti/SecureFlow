import { NextResponse, type NextRequest } from "next/server";

export interface DeprecationOptions {
  /**
   * When deprecation began (date or boolean true).
   * Emitted as `Deprecation: <date>` or `Deprecation: @1` per RFC 8594.
   */
  deprecatedAt?: Date | string | boolean;
  /**
   * Sunset date when the endpoint will be turned off / removed.
   * Emitted as `Sunset: <IMF-fixdate>`.
   */
  sunsetAt?: Date | string;
  /**
   * Successor endpoint URL or migration guide link.
   * Emitted as `Link: <...>; rel="successor-version"`.
   */
  successorUrl?: string;
  /**
   * Additional Link header relations or documentation links.
   * e.g., 'https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/api-versioning.md'
   */
  policyUrl?: string;
}

export const DEFAULT_API_VERSIONING_POLICY_URL =
  "https://github.com/GauravKarakoti/SecureFlow/blob/main/docs/api-versioning.md";

/**
 * Formats a Date into IMF-fixdate (RFC 7231 / RFC 8594 / HTTP date).
 * e.g., "Sun, 01 Nov 2026 00:00:00 GMT"
 */
export function formatHttpDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date provided to formatHttpDate: ${date}`);
  }
  return d.toUTCString();
}

/**
 * Appends standard RFC 8594 Deprecation and Sunset headers to an existing Response, Headers, or mock response object.
 */
export function addDeprecationHeaders(target: any, options: DeprecationOptions = {}): void {
  if (!target) return;

  const getHeader = (name: string): string | null => {
    if (typeof target.get === "function") {
      return target.get(name);
    }
    if (target.headers) {
      if (typeof target.headers.get === "function") {
        return target.headers.get(name);
      }
      if (typeof target.headers === "object") {
        return target.headers[name] ?? target.headers[name.toLowerCase()] ?? null;
      }
    }
    return null;
  };

  const setHeader = (name: string, value: string): void => {
    if (typeof target.set === "function") {
      target.set(name, value);
      return;
    }
    if (target.headers) {
      if (typeof target.headers.set === "function") {
        target.headers.set(name, value);
        return;
      }
      if (typeof target.headers === "object") {
        target.headers[name] = value;
        return;
      }
    }
    // If target has no headers property, initialize headers map/object
    try {
      if (typeof Headers !== "undefined") {
        target.headers = new Headers();
        target.headers.set(name, value);
        return;
      }
    } catch {
      // Fallback to plain object
    }
    target.headers = { [name]: value };
  };

  // 1. Deprecation header
  if (options.deprecatedAt !== undefined) {
    if (typeof options.deprecatedAt === "boolean") {
      if (options.deprecatedAt) {
        setHeader("Deprecation", "@1");
      }
    } else {
      setHeader("Deprecation", formatHttpDate(options.deprecatedAt));
    }
  } else {
    // Default to boolean @1 if deprecation helper is called without explicit date
    setHeader("Deprecation", "@1");
  }

  // 2. Sunset header
  if (options.sunsetAt !== undefined) {
    setHeader("Sunset", formatHttpDate(options.sunsetAt));
  }

  // 3. Link headers
  const linkParts: string[] = [];
  if (options.successorUrl) {
    linkParts.push(`<${options.successorUrl}>; rel="successor-version"`);
  }

  const policy = options.policyUrl ?? DEFAULT_API_VERSIONING_POLICY_URL;
  if (policy) {
    linkParts.push(`<${policy}>; rel="deprecation"`);
  }

  if (linkParts.length > 0) {
    const existingLink = getHeader("Link");
    if (existingLink) {
      setHeader("Link", `${existingLink}, ${linkParts.join(", ")}`);
    } else {
      setHeader("Link", linkParts.join(", "));
    }
  }
}

/**
 * Higher-order function wrapping a Next.js App Router route handler to inject
 * Deprecation and Sunset headers into every outgoing response.
 */
export function withDeprecation<Handler extends (...args: any[]) => Promise<Response> | Response>(
  handler: Handler,
  options: DeprecationOptions = {},
): Handler {
  const wrapped = async (...args: Parameters<Handler>): Promise<Response> => {
    const response = await handler(...args);
    addDeprecationHeaders(response, options);
    return response;
  };

  return wrapped as Handler;
}
