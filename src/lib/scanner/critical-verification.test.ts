import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseVerificationResponse,
  verifySingleCriticalFinding,
  verifyCriticalFindings,
  DEFAULT_MAX_VERIFICATION_CALLS,
} from "./critical-verification";
import { ArmorIQPolicyEngine } from "@/lib/armor/iq";
import type { ScanFinding } from "@/lib/armor/scanner";

const createFinding = (overrides?: Partial<ScanFinding>): ScanFinding => ({
  type: "Vulnerability",
  severity: "CRITICAL",
  description: "Potential remote code execution",
  fileLocation: "src/server.ts",
  codeSnippet: "eval(req.body.code);",
  lineStart: 42,
  lineEnd: 42,
  ...overrides,
});

describe("critical finding secondary verification pass (#2007)", () => {
  const iq = new ArmorIQPolicyEngine();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("parseVerificationResponse", () => {
    it("parses valid JSON with CONFIRM decision", () => {
      const response = JSON.stringify({
        decision: "CONFIRM",
        reason: "Active eval on user input without sanitization",
      });
      const result = parseVerificationResponse(response);
      expect(result.decision).toBe("CONFIRM");
      expect(result.reason).toBe("Active eval on user input without sanitization");
    });

    it("parses valid JSON with REJECT decision", () => {
      const response = JSON.stringify({
        decision: "REJECT",
        reason: "Input is a hardcoded internal test string, not user controlled",
      });
      const result = parseVerificationResponse(response);
      expect(result.decision).toBe("REJECT");
      expect(result.reason).toBe("Input is a hardcoded internal test string, not user controlled");
    });

    it("parses alternative status keywords like UNVERIFIED or REJECTED", () => {
      const response1 = JSON.stringify({
        status: "UNVERIFIED",
        reason: "Test mock placeholder",
      });
      expect(parseVerificationResponse(response1).decision).toBe("REJECT");

      const response2 = JSON.stringify({
        verdict: "REJECTED",
        reason: "Benign documentation snippet",
      });
      expect(parseVerificationResponse(response2).decision).toBe("REJECT");

      const response3 = JSON.stringify({
        confirmed: false,
        reason: "Non-exploitable context",
      });
      expect(parseVerificationResponse(response3).decision).toBe("REJECT");
    });

    it("handles reasoning or thinking tags in LLM output", () => {
      const response =
        "<think>Looking at the snippet, it's just a test.</think>" +
        JSON.stringify({
          decision: "REJECT",
          reason: "Mock test fixture only",
        });
      const result = parseVerificationResponse(response);
      expect(result.decision).toBe("REJECT");
      expect(result.reason).toBe("Mock test fixture only");
    });

    it("falls back to keyword matching when response is not valid JSON", () => {
      const rejectText = "I reject this finding because it is an unverified false positive.";
      expect(parseVerificationResponse(rejectText).decision).toBe("REJECT");

      const confirmText = "This is a real critical issue.";
      expect(parseVerificationResponse(confirmText).decision).toBe("CONFIRM");
    });

    it("handles null or undefined input gracefully", () => {
      expect(parseVerificationResponse("").decision).toBe("CONFIRM");
    });
  });

  describe("verifySingleCriticalFinding with mocked client", () => {
    it("confirms critical finding when model returns confirm response", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "CONFIRM",
                      reason: "Confirmed real injection vulnerability",
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const finding = createFinding();
      const result = await verifySingleCriticalFinding(finding, { groqClient: mockGroq });

      expect(mockGroq.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(result.decision).toBe("CONFIRM");
      expect(result.reason).toBe("Confirmed real injection vulnerability");
    });

    it("rejects critical finding when model returns reject response", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "REJECT",
                      reason: "Safe sanitized input in test file",
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const finding = createFinding();
      const result = await verifySingleCriticalFinding(finding, { groqClient: mockGroq });

      expect(result.decision).toBe("REJECT");
      expect(result.reason).toBe("Safe sanitized input in test file");
    });

    it("handles model error gracefully by retaining finding as confirmed with error reason", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("Groq API rate limit or timeout")),
          },
        },
      } as any;

      const finding = createFinding();
      const result = await verifySingleCriticalFinding(finding, { groqClient: mockGroq });

      expect(result.decision).toBe("CONFIRM");
      expect(result.reason).toContain("Groq API rate limit or timeout");
    });
  });

  describe("verifyCriticalFindings end-to-end integration with gate policy", () => {
    it("does not run verification when unconfigured (opt-in)", async () => {
      const mockGroq = {
        chat: { completions: { create: vi.fn() } },
      } as any;

      const findings = [createFinding()];
      const result = await verifyCriticalFindings(findings, {
        gateConfig: { blockOn: "CRITICAL", reviewOn: "MEDIUM" },
        groqClient: mockGroq,
      });

      expect(mockGroq.chat.completions.create).not.toHaveBeenCalled();
      expect(result[0].verificationStatus).toBeUndefined();
      // Unverified critical finding still blocks by default
      expect(iq.evaluateFindings(result)).toBe("BLOCKED");
    });

    it("acceptance criteria: confirmed critical findings still block", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "CONFIRM",
                      reason: "Real remote code execution flaw",
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const findings = [createFinding()];
      await verifyCriticalFindings(findings, {
        gateConfig: { blockOn: "CRITICAL", reviewOn: "MEDIUM", verifyCritical: true },
        groqClient: mockGroq,
      });

      expect(mockGroq.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(findings[0].verificationStatus).toBe("CONFIRMED");
      expect(findings[0].verificationReason).toBe("Real remote code execution flaw");

      // Confirmed critical finding BLOCKS
      expect(iq.evaluateFindings(findings)).toBe("BLOCKED");
    });

    it("acceptance criteria: rejected findings do not block and show the verification reason", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "REJECT",
                      reason: "Harmless mock token inside test fixture",
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      const findings = [createFinding()];
      await verifyCriticalFindings(findings, {
        gateConfig: { blockOn: "CRITICAL", reviewOn: "MEDIUM", verifyCritical: true },
        groqClient: mockGroq,
      });

      expect(mockGroq.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(findings[0].verificationStatus).toBe("UNVERIFIED");
      expect(findings[0].verificationReason).toBe("Harmless mock token inside test fixture");

      // Rejected finding does NOT block!
      expect(iq.evaluateFindings(findings)).toBe("PASS");
    });

    it("acceptance criteria: call limit per scan is enforced", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      decision: "REJECT",
                      reason: "False positive",
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      // 5 critical findings, but limit is 2
      const findings = Array.from({ length: 5 }, (_, i) =>
        createFinding({ fileLocation: `src/file${i}.ts` }),
      );

      await verifyCriticalFindings(findings, {
        gateConfig: {
          blockOn: "CRITICAL",
          reviewOn: "MEDIUM",
          verifyCritical: true,
          maxVerificationCalls: 2,
        },
        groqClient: mockGroq,
      });

      // Exactly 2 verification calls were made!
      expect(mockGroq.chat.completions.create).toHaveBeenCalledTimes(2);

      // The first 2 were rejected/unverified
      expect(findings[0].verificationStatus).toBe("UNVERIFIED");
      expect(findings[1].verificationStatus).toBe("UNVERIFIED");

      // The remaining 3 were not verified due to the call limit
      expect(findings[2].verificationStatus).toBeUndefined();
      expect(findings[3].verificationStatus).toBeUndefined();
      expect(findings[4].verificationStatus).toBeUndefined();

      // The unverified findings remaining still cause BLOCKED
      expect(iq.evaluateFindings(findings)).toBe("BLOCKED");
    });

    it("acceptance criteria: tests use mocked model responses for error and retain finding as blocking", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(new Error("503 Service Unavailable")),
          },
        },
      } as any;

      const findings = [createFinding()];
      await verifyCriticalFindings(findings, {
        gateConfig: { blockOn: "CRITICAL", reviewOn: "MEDIUM", verifyCritical: true },
        groqClient: mockGroq,
      });

      expect(mockGroq.chat.completions.create).toHaveBeenCalledTimes(1);
      expect(findings[0].verificationStatus).toBe("CONFIRMED");
      expect(findings[0].verificationReason).toContain("503 Service Unavailable");

      // On verification error, critical finding still blocks (safe default)
      expect(iq.evaluateFindings(findings)).toBe("BLOCKED");
    });

    it("evaluates to BLOCKED when one finding is confirmed and another is rejected", async () => {
      const mockGroq = {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockResolvedValueOnce({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        decision: "REJECT",
                        reason: "Benign test file",
                      }),
                    },
                  },
                ],
              })
              .mockResolvedValueOnce({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        decision: "CONFIRM",
                        reason: "Confirmed SQL injection in production handler",
                      }),
                    },
                  },
                ],
              }),
          },
        },
      } as any;

      const findingA = createFinding({ fileLocation: "src/test.ts" });
      const findingB = createFinding({ fileLocation: "src/prod.ts" });
      const findings = [findingA, findingB];

      await verifyCriticalFindings(findings, {
        gateConfig: { blockOn: "CRITICAL", reviewOn: "MEDIUM", verifyCritical: true },
        groqClient: mockGroq,
      });

      expect(findingA.verificationStatus).toBe("UNVERIFIED");
      expect(findingB.verificationStatus).toBe("CONFIRMED");

      // findingB is confirmed critical, so scan decision is BLOCKED
      expect(iq.evaluateFindings(findings)).toBe("BLOCKED");
    });
  });
});
