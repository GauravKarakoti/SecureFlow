import Groq from "groq-sdk";
import type { ScanFinding, FileChange } from "@/lib/armor/scanner";
import type { GateConfig } from "./gate-config";
import { resolveScanModel } from "@/lib/armor/scanner";
import { maskFindingText } from "@/lib/armor/secret-masking";

/** Default maximum number of verification calls per scan (#2007). */
export const DEFAULT_MAX_VERIFICATION_CALLS = 5;

/** Hard upper limit on verification calls per scan (#2007). */
export const MAX_VERIFICATION_CALLS_LIMIT = 20;

export interface VerificationResult {
  decision: "CONFIRM" | "REJECT";
  reason: string;
  rawResponse?: string;
}

export interface CriticalVerificationOptions {
  gateConfig?: GateConfig | null;
  fileChanges?: FileChange[];
  policies?: Array<{ description: string; [key: string]: unknown }>;
  maxCalls?: number;
  groqClient?: Groq;
  model?: string;
}

/**
 * Parses the raw LLM verification response into a structured decision and reason (#2007).
 */
export function parseVerificationResponse(text: string): VerificationResult {
  if (!text || typeof text !== "string") {
    return {
      decision: "CONFIRM",
      reason: "Empty verification response; retained",
      rawResponse: text,
    };
  }

  const withoutThoughts = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
  const jsonMatch = withoutThoughts.match(/[\{\[][\s\S]*[\}\]]/);

  if (!jsonMatch) {
    const lower = withoutThoughts.toLowerCase();
    if (
      lower.includes("reject") ||
      lower.includes("unverified") ||
      lower.includes("false positive")
    ) {
      return { decision: "REJECT", reason: withoutThoughts.trim(), rawResponse: text };
    }
    return { decision: "CONFIRM", reason: withoutThoughts.trim(), rawResponse: text };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const rawDecision = String(
      parsed.decision ??
        parsed.status ??
        parsed.verdict ??
        (parsed.confirmed === false ? "REJECT" : "CONFIRM"),
    )
      .trim()
      .toUpperCase();

    const decision: "CONFIRM" | "REJECT" =
      rawDecision === "REJECT" || rawDecision === "REJECTED" || rawDecision === "UNVERIFIED"
        ? "REJECT"
        : "CONFIRM";

    const reason = String(
      parsed.reason ?? parsed.explanation ?? parsed.description ?? "No reason provided",
    ).trim();

    return { decision, reason, rawResponse: text };
  } catch {
    return {
      decision: "CONFIRM",
      reason: "Failed to parse verification response JSON",
      rawResponse: text,
    };
  }
}

/**
 * Runs a short secondary verification prompt on a single CRITICAL finding (#2007).
 */
export async function verifySingleCriticalFinding(
  finding: ScanFinding,
  options?: {
    fileChanges?: FileChange[];
    policies?: Array<{ description: string; [key: string]: unknown }>;
    groqClient?: Groq;
    model?: string;
  },
): Promise<VerificationResult> {
  const groq =
    options?.groqClient ?? new Groq({ apiKey: process.env.GROQ_API_KEY || "dummy-key-for-build" });
  const model = options?.model ?? resolveScanModel();

  const policyContext =
    options?.policies && options.policies.length > 0
      ? options.policies.map((p, i) => `- Rule ${i + 1}: ${p.description}`).join("\n")
      : "Standard security gate: Flag genuine active high-impact vulnerabilities or secrets. Discard test fixtures, safe mocks, documentation, or non-executable code.";

  const prompt = `You are a security auditor performing a secondary verification pass on a CRITICAL finding to prevent false blocks on pull requests.

Reported Finding:
- Type: ${finding.type}
- Severity: ${finding.severity}
- File Location: ${finding.fileLocation}${finding.lineStart ? `:${finding.lineStart}` : ""}
- Description: ${finding.description}

Code Snippet:
${finding.codeSnippet || "No snippet provided"}

Enforced Security Policies:
${policyContext}

Task:
Determine whether this CRITICAL finding is a genuine, actionable vulnerability or hardcoded secret that should block merging, OR if it is a false positive (mock data, non-exploitable context, test fixture, or benign string) that should be rejected as UNVERIFIED.

Respond strictly in valid JSON format:
{
  "decision": "CONFIRM" | "REJECT",
  "reason": "Short one-sentence explanation of why this finding is confirmed as a real threat or rejected as unverified."
}`;

  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content:
            "You are an authorized defensive security auditing tool performing secondary verification. Output valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      model,
      temperature: 0.1,
      max_tokens: 500,
    });

    const responseText = response.choices[0]?.message?.content || "";
    return parseVerificationResponse(responseText);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[CriticalVerification] Verification call error: ${errMsg}`);
    return {
      decision: "CONFIRM",
      reason: `Verification error: ${errMsg} (retained)`,
    };
  }
}

/**
 * Runs secondary verification on CRITICAL findings before blocking a PR (#2007).
 * - Confirmed findings remain active and continue to block.
 * - Rejected findings are marked UNVERIFIED (non-blocking) with the verification reason.
 * - Enforces bounded call limit per scan (default 5, max 20).
 */
export async function verifyCriticalFindings(
  findings: ScanFinding[],
  options?: CriticalVerificationOptions,
): Promise<ScanFinding[]> {
  const gateConfig = options?.gateConfig;
  const isEnabled =
    gateConfig?.verifyCritical ??
    gateConfig?.verifyCriticalFindings ??
    process.env.VERIFY_CRITICAL_FINDINGS === "true";

  if (!isEnabled) {
    return findings;
  }

  const rawLimit = gateConfig?.maxVerificationCalls ?? process.env.MAX_VERIFICATION_CALLS;
  const maxCalls = Math.min(
    Math.max(
      1,
      typeof rawLimit === "number" ? rawLimit : Number(rawLimit) || DEFAULT_MAX_VERIFICATION_CALLS,
    ),
    MAX_VERIFICATION_CALLS_LIMIT,
  );

  // Identify CRITICAL findings that have not yet been verified
  const criticalCandidates = findings.filter(
    (f) => f.severity === "CRITICAL" && f.verificationStatus === undefined,
  );

  if (criticalCandidates.length === 0) {
    return findings;
  }

  // Bound the extra calls per scan to maxCalls
  const candidatesToVerify = criticalCandidates.slice(0, maxCalls);

  for (const finding of candidatesToVerify) {
    const result = await verifySingleCriticalFinding(finding, {
      fileChanges: options?.fileChanges,
      policies: options?.policies,
      groqClient: options?.groqClient,
      model: options?.model,
    });

    if (result.decision === "REJECT") {
      finding.verificationStatus = "UNVERIFIED";
      finding.verificationReason = maskFindingText(result.reason);
    } else {
      finding.verificationStatus = "CONFIRMED";
      finding.verificationReason = maskFindingText(result.reason);
    }
  }

  return findings;
}
