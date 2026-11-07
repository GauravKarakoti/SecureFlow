import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();

vi.mock("@/lib/prisma", () => ({
  default: { auditLog: { create: (...args: unknown[]) => create(...args) } },
}));

import { recordAiFallbackEvent } from "./ai-fallback-audit";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("recordAiFallbackEvent", () => {
  it("writes a sanitized audit log entry for the fallback", async () => {
    create.mockResolvedValue({});

    await recordAiFallbackEvent({
      fromModel: "groq/llama-3.3-70b",
      toModel: "openai/llama3.1",
      reason: "rate_limit",
    });

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.userId).toBeNull();
    // sanitizeAuditLogInput trims and uppercases the action.
    expect(data.action).toBe("AI MODEL FALLBACK");
    expect(data.resource).toBe("groq/llama-3.3-70b -> openai/llama3.1");
    expect(data.decision).toBe("rate_limit");
    expect(data.metadata).toMatchObject({
      fromModel: "groq/llama-3.3-70b",
      toModel: "openai/llama3.1",
      reason: "rate_limit",
    });
  });

  it("masks email addresses that appear in model ids via resource sanitization", async () => {
    create.mockResolvedValue({});

    await recordAiFallbackEvent({
      fromModel: "groq/user@example.com",
      toModel: "openai/llama3.1",
      reason: "timeout",
    });

    const resource = create.mock.calls[0]![0].data.resource as string;
    expect(resource).not.toContain("user@example.com");
  });

  it("never throws when the audit sink fails (fire-and-forget)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    create.mockRejectedValue(new Error("database is down"));

    await expect(
      recordAiFallbackEvent({ fromModel: "a", toModel: "b", reason: "timeout" }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[AI_FALLBACK_AUDIT]"),
      expect.any(Error),
    );
  });
});
