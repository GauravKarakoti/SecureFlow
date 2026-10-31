import { ArmorIQClient, IntentToken } from "@armoriq/sdk";
import { ScanFinding } from "./scanner";
import prisma from "@/lib/prisma";
import { z } from "zod";
import { isAtLeast, parseSeverity, type Severity } from "@/lib/severity";
import type { GateConfig, GateLevel } from "@/lib/scanner/gate-config";
import { DEFAULT_GATE_CONFIG } from "@/lib/scanner/gate-config";
import { ArmorIQUnavailableError, withArmorIQBreaker } from "./armoriq-breaker";

const armorIQConfigSchema = z.object({
  apiKey: z.string().default(""),
  userId: z.string().default("fallback-user"),
  agentId: z.string().default("fallback-agent"),
});

const armorIQConfig = armorIQConfigSchema.parse({
  apiKey: process.env.ARMORIQ_API_KEY || undefined,
  userId: process.env.USER_ID || undefined,
  agentId: process.env.AGENT_ID || undefined,
});

export type PolicyResult = "PASS" | "REVIEW REQUIRED" | "BLOCKED";

export class ArmorIQPolicyEngine {
  /**
   * Decide whether a pull request is blocked, needs review, or passes.
   *
   * Comparison goes through `@/lib/severity` instead of `===` on the raw value.
   * The exact-match version silently passed any finding whose severity was not
   * spelled in canonical uppercase: `Finding.severity` is an unconstrained
   * `String` in the schema, so a row reading `"critical"` failed the
   * `=== 'CRITICAL'` test, fell through both branches, and the pull request was
   * decided `PASS` with a critical vulnerability in it.
   *
   * A severity that cannot be interpreted at all is routed to REVIEW REQUIRED
   * rather than BLOCKED or PASS — we know the scanner reported something, we
   * just cannot rank it, so a human should look.
   */
  /**
   * Decide whether a pull request is blocked, needs review, or passes.
   *
   * Accepts an optional GateConfig parameter (loaded from .secureflow.json on the base branch).
   * Missing gate config falls back to DEFAULT_GATE_CONFIG (blockOn: CRITICAL, reviewOn: MEDIUM).
   *
   * Rules:
   * 1. BLOCKED if any active finding is at or above effective blockOn.
   * 2. Otherwise REVIEW REQUIRED if any finding is at or above effective reviewOn,
   *    or has an uninterpretable severity.
   * 3. Otherwise PASS.
   * Setting a level to NONE turns off that gate level.
   */
  evaluateFindings(findings: ScanFinding[], gate?: GateConfig | null): PolicyResult {
    const config = gate ?? DEFAULT_GATE_CONFIG;
    const globalBlock = config.blockOn;
    const globalReview = config.reviewOn;
    const overrides = config.overrides ?? [];

    const getFindingGate = (finding: ScanFinding): { blockOn: GateLevel; reviewOn: GateLevel } => {
      if (overrides.length > 0 && finding.type) {
        const typeNormalized = finding.type.trim().toUpperCase();
        const match = overrides.find((o) => o.type.trim().toUpperCase() === typeNormalized);
        if (match) {
          return {
            blockOn: match.blockOn ?? globalBlock,
            reviewOn: match.reviewOn ?? globalReview,
          };
        }
      }
      return { blockOn: globalBlock, reviewOn: globalReview };
    };

    // Check BLOCKED condition across all findings
    for (const finding of findings) {
      const { blockOn } = getFindingGate(finding);
      if (blockOn !== "NONE") {
        if (isAtLeast(finding.severity, blockOn as Severity)) {
          return "BLOCKED";
        }
      }
    }

    // Check REVIEW REQUIRED condition across all findings
    for (const finding of findings) {
      const parsed = parseSeverity(finding.severity);
      // Uninterpretable severity always requires human review
      if (parsed === null) {
        return "REVIEW REQUIRED";
      }

      const { reviewOn } = getFindingGate(finding);
      if (reviewOn !== "NONE") {
        if (isAtLeast(finding.severity, reviewOn as Severity)) {
          return "REVIEW REQUIRED";
        }
      }
    }

    return "PASS";
  }

  async getRiskTrend(filters?: { userId?: string; repositoryId?: string }): Promise<number> {
    try {
      const where: any = {};

      if (filters) {
        if (filters.repositoryId) {
          where.pullRequest = {
            repositoryId: filters.repositoryId,
          };
        } else if (filters.userId) {
          where.pullRequest = {
            repository: {
              userId: filters.userId,
            },
          };
        }
      }

      const aggregation = await prisma.scanResult.aggregate({
        where,
        _avg: {
          riskScore: true,
        },
      });
      return aggregation._avg.riskScore ?? 0;
    } catch (error) {
      console.error("Error fetching risk trend:", error);
      return 0;
    }
  }
}

export const iq = new ArmorIQPolicyEngine();

export class ArmorIQService {
  private static client: ArmorIQClient | null = null;

  /**
   * True when an ArmorIQ API key is configured (ARMORIQ_API_KEY).
   * The cloud client can only be constructed when this is true.
   */
  static isConfigured(): boolean {
    return armorIQConfig.apiKey.trim().length > 0;
  }

  /**
   * Singleton accessor for ArmorIQClient.
   * Returns null when ARMORIQ_API_KEY is not set, so callers can degrade
   * gracefully instead of crashing. The SDK itself throws if given an empty key.
   * Set ARMORIQ_API_KEY (get one at https://dev.armoriq.ai) to activate.
   */
  static getClient(): ArmorIQClient | null {
    if (!ArmorIQService.isConfigured()) {
      return null;
    }
    if (!ArmorIQService.client) {
      ArmorIQService.client = new ArmorIQClient({
        apiKey: armorIQConfig.apiKey,
        userId: armorIQConfig.userId,
        agentId: armorIQConfig.agentId,
      });
    }
    return ArmorIQService.client;
  }

  /**
   * Compiles local database policies into the programmatic ArmorIQ Policy format.
   * This bridges your custom UI with the ArmorIQ proxy guardrails.
   */
  static compileToArmorIQPolicy(dbPolicies: any[]): Record<string, any> {
    const activePolicies = dbPolicies.filter((p) => p.isActive);

    const compiledPolicy = {
      allow: [] as string[],
      deny: [] as string[],
      hold: [] as string[],
      priority: 50, // Default priority
    };

    for (const policy of activePolicies) {
      const rulesMeta = (policy.rules as any) || {};
      const action = rulesMeta.action || "REVIEW REQUIRED";
      const conditions = rulesMeta.conditions || [];

      // Map database logic to ArmorIQ glob patterns (e.g., "data-mcp/*")
      if (action === "BLOCKED" || action === "DENY") {
        compiledPolicy.deny.push(...conditions);
      } else if (action === "PASS" || action === "ALLOW") {
        compiledPolicy.allow.push(...conditions);
      } else if (
        action === "HOLD" ||
        action === "REVIEW REQUIRED" ||
        action === "HOLD FOR APPROVAL"
      ) {
        compiledPolicy.hold.push(...conditions);
      }
    }

    // Default deny if no explicit allows are set, to adhere to zero-trust
    if (
      compiledPolicy.allow.length === 0 &&
      compiledPolicy.deny.length === 0 &&
      compiledPolicy.hold.length === 0
    ) {
      compiledPolicy.deny.push("*:*");
    }

    return compiledPolicy;
  }

  /**
   * Complete token verification and cryptographic validation via ArmorIQ SDK client.
   */
  static async verifyIntentToken(
    token: string | IntentToken,
  ): Promise<{ valid: boolean; reason?: string; payload?: any; unavailable?: boolean }> {
    const client = this.getClient();

    if (!client) {
      return { valid: false, reason: "ArmorIQ is not configured" };
    }

    if (typeof token === "string" || !token.rawToken?.token) {
      return { valid: false, reason: "Invalid intent token" };
    }

    try {
      const tokenData = token.rawToken.token;
      const tokenPublicKey = tokenData.public_key;

      if (typeof tokenPublicKey !== "string" || !/^[0-9a-fA-F]{64}$/.test(tokenPublicKey)) {
        return { valid: false, reason: "Invalid token signing key" };
      }

      // One breaker execution covers both SDK calls. Wrapping them separately let the
      // successful key fetch reset the failure count, so a failing verifyToken never tripped it.
      return await withArmorIQBreaker(async () => {
        const trustedKey = await client.ensureIapPublicKey();

        if (!trustedKey || trustedKey.asymmetricKeyType !== "ed25519") {
          return {
            valid: false,
            reason: "Trusted ArmorIQ issuer key unavailable",
          };
        }

        const trustedDer = trustedKey.export({
          format: "der",
          type: "spki",
        });
        const trustedRawKey = trustedDer.subarray(-32);
        const suppliedRawKey = Buffer.from(tokenPublicKey, "hex");

        if (!trustedRawKey.equals(suppliedRawKey)) {
          return {
            valid: false,
            reason: "Token signing key is not trusted",
          };
        }

        const isValid = await client.verifyToken(token);

        return {
          valid: Boolean(isValid),
          reason: isValid ? undefined : "Cryptographic proof validation failed",
        };
      });
    } catch (error: unknown) {
      // Fail closed: an unreachable ArmorIQ never validates a token.
      return {
        valid: false,
        ...(error instanceof ArmorIQUnavailableError ? { unavailable: true } : {}),
        reason: error instanceof Error ? error.message : "Token verification failed",
      };
    }
  }

  /**
   * Evaluates action against programmatic zero-trust policies.
   */
  static checkActionPermission(
    action: string,
    compiledPolicy: Record<string, any>,
  ): { allowed: boolean; status: "ALLOW" | "DENY" | "HOLD"; reason: string } {
    const allowList = compiledPolicy.allow || [];
    const denyList = compiledPolicy.deny || [];
    const holdList = compiledPolicy.hold || [];

    const isMatch = (patterns: string[], target: string) =>
      patterns.some((pattern) => {
        if (pattern === "*:*" || pattern === "*") return true;
        if (pattern.endsWith("/*")) {
          return target.startsWith(pattern.slice(0, -2));
        }
        return pattern.toLowerCase() === target.toLowerCase();
      });

    if (isMatch(denyList, action)) {
      return {
        allowed: false,
        status: "DENY",
        reason: `Action '${action}' explicitly denied by ArmorIQ policy`,
      };
    }

    if (isMatch(holdList, action)) {
      return {
        allowed: false,
        status: "HOLD",
        reason: `Action '${action}' held for maintainer approval`,
      };
    }

    if (isMatch(allowList, action)) {
      return {
        allowed: true,
        status: "ALLOW",
        reason: `Action '${action}' permitted by ArmorIQ policy`,
      };
    }

    // Default zero-trust fallback
    return {
      allowed: false,
      status: "DENY",
      reason: `Action '${action}' rejected by default zero-trust policy`,
    };
  }

  /**
   * Evaluates an agent action against compiled ArmorIQ policy.
   * Routine actions (e.g., formatting) are allowed; high-risk actions (modifying lockfiles, deployments) are held.
   */
  static evaluateActionPolicy(
    actionName: string,
    params: Record<string, any> = {},
  ): { status: "allow" | "deny" | "hold"; reason: string; requiresHumanApproval: boolean } {
    const actionLower = actionName.toLowerCase();
    const targetFile = String(params.filePath || params.file || "").toLowerCase();

    // High-risk actions requiring human maintainer hold-for-approval
    const isLockfileModification =
      targetFile.includes("package-lock.json") ||
      targetFile.includes("pnpm-lock.yaml") ||
      targetFile.includes("yarn.lock") ||
      targetFile.includes("cargo.lock") ||
      targetFile.includes("gemfile.lock");

    const isDirectDeployment =
      actionLower.includes("deploy") ||
      actionLower.includes("publish") ||
      actionLower.includes("release") ||
      actionLower.includes("trigger_deployment");

    const isCredentialChange =
      actionLower.includes("secret") ||
      actionLower.includes("credential") ||
      targetFile.includes(".env");

    if (isLockfileModification) {
      return {
        status: "hold",
        reason:
          "Modifying dependency lockfiles requires human maintainer review and approval to prevent supply chain poisoning.",
        requiresHumanApproval: true,
      };
    }

    if (isDirectDeployment) {
      return {
        status: "hold",
        reason:
          "Direct deployment actions are high-risk CI/CD operations requiring maintainer approval.",
        requiresHumanApproval: true,
      };
    }

    if (isCredentialChange) {
      return {
        status: "hold",
        reason: "Actions touching secrets or credentials require manual approval.",
        requiresHumanApproval: true,
      };
    }

    // Routine actions allowed (e.g. formatting, linting, docs, test)
    if (
      actionLower.includes("format") ||
      actionLower.includes("prettier") ||
      actionLower.includes("lint") ||
      actionLower.includes("scan")
    ) {
      return {
        status: "allow",
        reason: "Routine code maintenance and inspection allowed automatically.",
        requiresHumanApproval: false,
      };
    }

    return {
      status: "allow",
      reason: "Action permitted under standard automated developer permissions.",
      requiresHumanApproval: false,
    };
  }

  /**
   * Helper to quickly get a token using the compiled programmatic policy.
   */
  static async getProtectedToken(
    userEmail: string,
    planCapture: any,
    dbPolicies: any[],
  ): Promise<IntentToken> {
    const client = this.getClient();
    if (!client) {
      throw new Error(
        "ArmorIQ is not configured. Set ARMORIQ_API_KEY (get one at https://dev.armoriq.ai) to mint intent tokens.",
      );
    }
    const scope = client.forUser(userEmail);
    const policy = this.compileToArmorIQPolicy(dbPolicies);

    // Binds the programmatic policy to the token during minting
    return await withArmorIQBreaker(() => client.getIntentToken(planCapture, policy, 3600));
  }
}
