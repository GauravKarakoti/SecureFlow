import {
  trace,
  context,
  propagation,
  SpanStatusCode,
  ROOT_CONTEXT,
  defaultTextMapSetter,
  defaultTextMapGetter,
  type Tracer,
  type Span,
  type Context,
} from "@opentelemetry/api";

export type { Context, Span, Tracer };
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const w3cPropagator = new W3CTraceContextPropagator();

let sdkInstance: NodeSDK | null = null;
let isInitialized = false;

/**
 * Returns true only when OTEL_EXPORTER_OTLP_ENDPOINT is defined and non-empty.
 */
export function isTracingEnabled(): boolean {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return Boolean(endpoint && endpoint.length > 0);
}

/**
 * List of forbidden attribute substrings and patterns that must NEVER be attached to spans.
 * Protects source code snippets, raw file patches, LLM prompts, secrets, and auth tokens.
 */
export const FORBIDDEN_ATTRIBUTE_KEYS = [
  "code",
  "codesnippet",
  "code_snippet",
  "snippet",
  "patch",
  "diff",
  "raw_diff",
  "prompt",
  "prompt_text",
  "secret",
  "secrets",
  "token",
  "tokens",
  "password",
  "passwords",
  "credential",
  "credentials",
  "private_key",
  "authorization",
  "auth_header",
] as const;

const SENSITIVE_VALUE_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/, // GitHub Personal Access Token
  /github_pat_[a-zA-Z0-9_]{82}/, // GitHub Fine-grained PAT
  /gho_[a-zA-Z0-9]{36}/, // GitHub OAuth Access Token
  /sk_live_[0-9a-zA-Z]{24,}/, // Stripe / Provider Live Key
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/i, // Bearer Token
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, // Private Key
];

/**
 * Validates whether an attribute key is safe to record on a telemetry span.
 */
export function isSafeAttributeKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const forbidden of FORBIDDEN_ATTRIBUTE_KEYS) {
    if (lower === forbidden || lower.includes(`.${forbidden}`) || lower.endsWith(`_${forbidden}`)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates whether an attribute value is safe (contains no known credential patterns or multiline code).
 */
export function isSafeAttributeValue(val: unknown): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === "number" || typeof val === "boolean") return true;

  if (typeof val === "string") {
    // Exclude multiline code blocks or large source texts (> 1000 characters)
    if (val.length > 1000 || val.includes("\n")) {
      return false;
    }
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(val)) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Sanitizes attributes to ensure NO source code, snippets, prompts, or credentials leak into traces.
 */
export function sanitizeSpanAttributes(
  attributes: Record<string, unknown> = {},
): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!isSafeAttributeKey(key)) {
      continue;
    }

    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
      continue;
    }

    if (typeof value === "string") {
      if (isSafeAttributeValue(value)) {
        sanitized[key] = value;
      }
    }
  }

  return sanitized;
}

/**
 * Attaches sanitized attributes to a span, silently dropping any code, secrets, or tokens.
 */
export function setSafeAttributes(span: Span, attributes: Record<string, unknown>): void {
  const clean = sanitizeSpanAttributes(attributes);
  for (const [k, v] of Object.entries(clean)) {
    span.setAttribute(k, v);
  }
}

/**
 * Injects the active trace context into a carrier dictionary for propagation across BullMQ job payloads.
 * Accepts an optional Context or Span to inject explicitly.
 */
export function injectTraceContext(
  carrier: Record<string, string> = {},
  ctx?: Context | Span,
): Record<string, string> {
  let targetCtx: Context;
  if (!ctx) {
    targetCtx = context.active();
  } else if ("spanContext" in ctx) {
    targetCtx = trace.setSpan(context.active(), ctx);
  } else {
    targetCtx = ctx;
  }

  // Ensure standard W3C traceparent and tracestate are always written
  w3cPropagator.inject(targetCtx, carrier, defaultTextMapSetter);
  propagation.inject(targetCtx, carrier);
  return carrier;
}

/**
 * Extracts a parent trace context from a carrier dictionary (e.g., job.data.traceContext).
 */
export function extractTraceContext(carrier?: Record<string, unknown> | null): Context {
  if (!carrier || typeof carrier !== "object") {
    return ROOT_CONTEXT;
  }

  const stringCarrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(carrier)) {
    if (typeof v === "string") {
      stringCarrier[k] = v;
    }
  }

  const fromGlobal = propagation.extract(ROOT_CONTEXT, stringCarrier);
  const spanContext = trace.getSpanContext(fromGlobal);
  if (
    spanContext &&
    spanContext.traceId &&
    spanContext.traceId !== "00000000000000000000000000000000"
  ) {
    return fromGlobal;
  }

  return w3cPropagator.extract(ROOT_CONTEXT, stringCarrier, defaultTextMapGetter);
}

/**
 * Gets a named tracer instance. When tracing is disabled, OpenTelemetry returns a no-op tracer with zero overhead.
 */
export function getTracer(name = "secureflow", version = "0.1.0"): Tracer {
  return trace.getTracer(name, version);
}

/**
 * Executes an asynchronous function within an active OpenTelemetry span.
 * Handles parent context linking, status codes, exception recording, and attribute sanitization.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options: {
    attributes?: Record<string, unknown>;
    parentContext?: Context;
    startTime?: number | Date;
  } = {},
): Promise<T> {
  const tracer = getTracer();
  const parentCtx = options.parentContext ?? context.active();

  return tracer.startActiveSpan(
    name,
    options.startTime !== undefined ? { startTime: options.startTime } : {},
    parentCtx,
    async (span) => {
      // Wrap setAttribute and setAttributes to strictly prevent any code, snippets, or secrets from being attached
      const origSetAttribute = span.setAttribute.bind(span);
      const origSetAttributes = span.setAttributes.bind(span);

      span.setAttribute = (key: string, value: any) => {
        if (isSafeAttributeKey(key) && isSafeAttributeValue(value)) {
          origSetAttribute(key, value);
        }
        return span;
      };

      span.setAttributes = (attributes: Record<string, unknown>) => {
        const clean = sanitizeSpanAttributes(attributes);
        origSetAttributes(clean);
        return span;
      };

      if (options.attributes) {
        setSafeAttributes(span, options.attributes);
      }

      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Initializes the OpenTelemetry Node SDK when OTEL_EXPORTER_OTLP_ENDPOINT is configured.
 * When the endpoint is unset, tracing remains completely disabled with no network or memory overhead.
 */
export async function initTracing(): Promise<NodeSDK | null> {
  if (!isTracingEnabled()) {
    return null;
  }

  if (isInitialized && sdkInstance) {
    return sdkInstance;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT!.trim();
  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || "secureflow";

  const traceExporter = new OTLPTraceExporter({
    url: endpoint.endsWith("/v1/traces")
      ? endpoint
      : endpoint.endsWith("/")
        ? `${endpoint}v1/traces`
        : `${endpoint}/v1/traces`,
  });

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    "service.version": "0.1.0",
    "deployment.environment": process.env.NODE_ENV || "development",
  });

  sdkInstance = new NodeSDK({
    resource,
    traceExporter,
  });

  try {
    sdkInstance.start();
    isInitialized = true;
    return sdkInstance;
  } catch (err) {
    console.error("[Tracing] Failed to initialize OpenTelemetry SDK:", err);
    return null;
  }
}

/**
 * Gracefully shuts down the OpenTelemetry Node SDK exporter.
 */
export async function shutdownTracing(): Promise<void> {
  if (sdkInstance) {
    try {
      await sdkInstance.shutdown();
    } catch (err) {
      console.warn("[Tracing] Error shutting down OpenTelemetry SDK:", err);
    } finally {
      sdkInstance = null;
      isInitialized = false;
    }
  }
}
