import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isTracingEnabled,
  initTracing,
  shutdownTracing,
  withSpan,
  injectTraceContext,
  extractTraceContext,
  sanitizeSpanAttributes,
  isSafeAttributeKey,
  isSafeAttributeValue,
  FORBIDDEN_ATTRIBUTE_KEYS,
} from "./index";
import { trace, context, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

describe("OpenTelemetry Tracing Module", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(async () => {
    await shutdownTracing();
    process.env = originalEnv;
  });

  describe("Disabled Tracing Behavior", () => {
    it("reports tracing disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset", () => {
      expect(isTracingEnabled()).toBe(false);
    });

    it("reports tracing disabled when OTEL_EXPORTER_OTLP_ENDPOINT is empty whitespace", () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "   ";
      expect(isTracingEnabled()).toBe(false);
    });

    it("initTracing returns null with no errors when endpoint is unset", async () => {
      const sdk = await initTracing();
      expect(sdk).toBeNull();
    });

    it("withSpan runs user function seamlessly with zero overhead when tracing is disabled", async () => {
      const result = await withSpan("test.noop", async (span) => {
        expect(span).toBeDefined();
        span.setAttribute("test.key", "value");
        return 42;
      });

      expect(result).toBe(42);
    });

    it("withSpan bubbles errors correctly when user function throws", async () => {
      await expect(
        withSpan("test.error", async () => {
          throw new Error("scan failed test");
        }),
      ).rejects.toThrow("scan failed test");
    });
  });

  describe("Trace Context Propagation", () => {
    it("injects and extracts context across carrier object", () => {
      const carrier: Record<string, string> = {};
      injectTraceContext(carrier);

      // Carrier is a dictionary
      expect(typeof carrier).toBe("object");

      const extracted = extractTraceContext(carrier);
      expect(extracted).toBeDefined();
    });

    it("handles null or invalid carrier gracefully", () => {
      const fromNull = extractTraceContext(null);
      expect(fromNull).toBe(ROOT_CONTEXT);

      const fromUndefined = extractTraceContext(undefined);
      expect(fromUndefined).toBe(ROOT_CONTEXT);

      const fromNonObject = extractTraceContext("not-an-object" as any);
      expect(fromNonObject).toBe(ROOT_CONTEXT);
    });
  });

  describe("Attribute Sanitization and Privacy Enforcement", () => {
    it("forbids any attribute key matching sensitive terms", () => {
      for (const forbidden of FORBIDDEN_ATTRIBUTE_KEYS) {
        expect(isSafeAttributeKey(forbidden)).toBe(false);
        expect(isSafeAttributeKey(`secureflow.${forbidden}`)).toBe(false);
        expect(isSafeAttributeKey(`llm_${forbidden}`)).toBe(false);
      }
    });

    it("permits safe operational attribute keys", () => {
      const safeKeys = [
        "secureflow.correlation_id",
        "secureflow.repository_id",
        "secureflow.pr_number",
        "secureflow.head_sha",
        "secureflow.findings_count",
        "secureflow.decision",
        "secureflow.wait_ms",
        "secureflow.queue",
        "llm.finding_type",
        "llm.severity",
      ];

      for (const key of safeKeys) {
        expect(isSafeAttributeKey(key)).toBe(true);
      }
    });

    it("rejects multiline code values and sensitive patterns", () => {
      // Multiline code
      expect(isSafeAttributeValue("function test() {\n  return 1;\n}")).toBe(false);

      // Secret tokens (constructed dynamically to avoid push-protection false positives)
      const mockGhp = ["ghp", "123456789012345678901234567890123456"].join("_");
      const mockStripe = ["sk", "live", "123456789012345678901234"].join("_");
      expect(isSafeAttributeValue(mockGhp)).toBe(false);
      expect(isSafeAttributeValue("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz")).toBe(false);
      expect(isSafeAttributeValue(mockStripe)).toBe(false);
      expect(isSafeAttributeValue("-----BEGIN RSA PRIVATE KEY-----xyz")).toBe(false);

      // Safe values
      expect(isSafeAttributeValue("main")).toBe(true);
      expect(isSafeAttributeValue("owner/repo")).toBe(true);
      expect(isSafeAttributeValue("c8e4d2a1b9f678901234567890abcdef12345678")).toBe(true);
      expect(isSafeAttributeValue(123)).toBe(true);
      expect(isSafeAttributeValue(true)).toBe(true);
    });

    it("sanitizes attribute dictionaries, dropping code, snippets, and credentials", () => {
      const mockGhp = ["ghp", "123456789012345678901234567890123456"].join("_");
      const attributes = {
        "secureflow.correlation_id": "corr-1234",
        "secureflow.pr_number": 42,
        "secureflow.decision": "PASS",
        // Prohibited keys:
        code: "const x = 1;",
        code_snippet: "password = 'admin'",
        raw_diff: "diff --git a/test.ts b/test.ts",
        secret: "super-secret-value",
        token: mockGhp,
        password: "my-password",
        authorization: "Bearer secret",
        prompt: "You are a code analyzer: verify this code",
        // Sensitive values in allowed keys:
        "secureflow.bad_val": mockGhp,
        "secureflow.multiline": "line1\nline2",
      };

      const clean = sanitizeSpanAttributes(attributes);

      expect(clean).toEqual({
        "secureflow.correlation_id": "corr-1234",
        "secureflow.pr_number": 42,
        "secureflow.decision": "PASS",
      });

      expect(clean).not.toHaveProperty("code");
      expect(clean).not.toHaveProperty("code_snippet");
      expect(clean).not.toHaveProperty("raw_diff");
      expect(clean).not.toHaveProperty("secret");
      expect(clean).not.toHaveProperty("token");
      expect(clean).not.toHaveProperty("password");
      expect(clean).not.toHaveProperty("authorization");
      expect(clean).not.toHaveProperty("prompt");
      expect(clean).not.toHaveProperty("secureflow.bad_val");
      expect(clean).not.toHaveProperty("secureflow.multiline");
    });
  });

  describe("End-to-End Trace Simulation with Child Spans", () => {
    let memoryExporter: InMemorySpanExporter;
    let provider: BasicTracerProvider;
    let contextManager: AsyncLocalStorageContextManager;

    beforeEach(() => {
      memoryExporter = new InMemorySpanExporter();
      provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(memoryExporter)],
      });
      trace.setGlobalTracerProvider(provider);

      contextManager = new AsyncLocalStorageContextManager();
      contextManager.enable();
      context.setGlobalContextManager(contextManager);
    });

    afterEach(async () => {
      contextManager.disable();
      context.disable();
      trace.disable();
      await provider.shutdown();
    });

    it("produces a root span and all expected child spans in the same trace without leaking code", async () => {
      const correlationId = "corr-test-e2e";
      const carrier: Record<string, string> = {};

      // 1. Root span: webhook.delivery
      await withSpan("webhook.delivery", async (rootSpan) => {
        rootSpan.setAttribute("secureflow.correlation_id", correlationId);
        rootSpan.setAttribute("secureflow.repository_id", "acme/api");
        rootSpan.setAttribute("secureflow.pr_number", 101);

        // Attempt to attach sensitive attributes (should be ignored)
        rootSpan.setAttribute("code", "function leak() {}");
        rootSpan.setAttribute("secret", "token-xyz");

        // Inject trace context to carrier
        injectTraceContext(carrier, rootSpan);
      });

      // Verify carrier has traceparent
      expect(carrier.traceparent).toBeDefined();

      // Extract context in worker
      const extractedContext = extractTraceContext(carrier);

      // 2. Child span: queue.wait
      await withSpan(
        "queue.wait",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.queue", "github-webhooks");
          span.setAttribute("secureflow.wait_ms", 120);
        },
        { parentContext: extractedContext },
      );

      // 3. Child span: diff.fetch
      await withSpan(
        "diff.fetch",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.repository_id", "acme/api");
          span.setAttribute("secureflow.pr_number", 101);
          span.setAttribute("secureflow.changed_files_count", 3);
        },
        { parentContext: extractedContext },
      );

      // 4. Child span: scan.execute
      await withSpan(
        "scan.execute",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.repository_id", "acme/api");
          span.setAttribute("secureflow.files_scanned", 3);
          span.setAttribute("secureflow.findings_count", 1);
        },
        { parentContext: extractedContext },
      );

      // 5. Child span: llm.request
      await withSpan(
        "llm.request",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("llm.finding_type", "SQL_INJECTION");
          span.setAttribute("llm.severity", "HIGH");
        },
        { parentContext: extractedContext },
      );

      // 6. Child span: db.write
      await withSpan(
        "db.write",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.findings_persisted", 1);
          span.setAttribute("secureflow.risk_score", 75);
          span.setAttribute("secureflow.policy_decision", "BLOCK");
        },
        { parentContext: extractedContext },
      );

      // 7. Child span: check_run.update
      await withSpan(
        "check_run.update",
        async (span) => {
          span.setAttribute("secureflow.correlation_id", correlationId);
          span.setAttribute("secureflow.decision", "BLOCKED");
          span.setAttribute("secureflow.findings_count", 1);
        },
        { parentContext: extractedContext },
      );

      const spans = memoryExporter.getFinishedSpans();
      expect(spans).toHaveLength(7);

      const spanNames = spans.map((s) => s.name);
      expect(spanNames).toContain("webhook.delivery");
      expect(spanNames).toContain("queue.wait");
      expect(spanNames).toContain("diff.fetch");
      expect(spanNames).toContain("scan.execute");
      expect(spanNames).toContain("llm.request");
      expect(spanNames).toContain("db.write");
      expect(spanNames).toContain("check_run.update");

      const rootSpan = spans.find((s) => s.name === "webhook.delivery")!;
      const traceId = rootSpan.spanContext().traceId;
      expect(traceId).toBeDefined();

      // All spans share the same traceId across the async boundary
      for (const s of spans) {
        expect(s.spanContext().traceId).toBe(traceId);
        expect(s.attributes["secureflow.correlation_id"]).toBe(correlationId);

        // Verify NO forbidden code, snippet, or credential leaked into any span
        for (const [key, value] of Object.entries(s.attributes)) {
          expect(isSafeAttributeKey(key)).toBe(true);
          expect(isSafeAttributeValue(value)).toBe(true);
        }
      }
    });
  });
});
