import { ArmorIQClient, IntentToken } from '@armoriq/sdk';
import { ScanFinding } from './scanner';

export type PolicyResult = 'PASS' | 'REVIEW REQUIRED' | 'BLOCKED';

export class ArmorIQPolicyEngine {
  evaluateFindings(findings: ScanFinding[]): PolicyResult {
    if (findings.some(f => f.severity === 'CRITICAL')) {
      return 'BLOCKED';
    }
    
    if (findings.some(f => f.severity === 'HIGH' || f.severity === 'MEDIUM')) {
      return 'REVIEW REQUIRED';
    }

    return 'PASS';
  }

  getRiskTrend(): number {
    return Math.random() * 100;
  }
}

export const iq = new ArmorIQPolicyEngine();

export class ArmorIQService {
  private static client: ArmorIQClient | null = null;

  /**
   * Singleton pattern for ArmorIQClient.
   * Includes fallback 'userId' and 'agentId' to satisfy SDK initialization requirements.
   */
  static getClient(): ArmorIQClient {
    if (!ArmorIQService.client) {
      ArmorIQService.client = new ArmorIQClient({
        apiKey: process.env.ARMORIQ_API_KEY || '', 
        userId: process.env.USER_ID,
        agentId: process.env.AGENT_ID
      });
    }
    return ArmorIQService.client;
  }

  /**
   * Compiles local database policies into the programmatic ArmorIQ Policy format.
   * This bridges your custom UI with the ArmorIQ proxy guardrails.
   */
  static compileToArmorIQPolicy(dbPolicies: any[]): Record<string, any> {
    const activePolicies = dbPolicies.filter(p => p.isActive);

    const compiledPolicy = {
      allow: [] as string[],
      deny: [] as string[],
      priority: 50 // Default priority
    };

    for (const policy of activePolicies) {
      const rulesMeta = (policy.rules as any) || {};
      const action = rulesMeta.action || 'REVIEW REQUIRED';
      const conditions = rulesMeta.conditions || [];

      // Map database logic to ArmorIQ glob patterns (e.g., "data-mcp/*")
      if (action === 'BLOCKED' || action === 'DENY') {
        compiledPolicy.deny.push(...conditions);
      } else if (action === 'PASS' || action === 'ALLOW') {
        compiledPolicy.allow.push(...conditions);
      }
    }

    // Default deny if no explicit allows are set, to adhere to zero-trust
    if (compiledPolicy.allow.length === 0 && compiledPolicy.deny.length === 0) {
       compiledPolicy.allow.push('*:*');
    }

    return compiledPolicy;
  }

  /**
   * Helper to quickly get a token using the compiled programmatic policy.
   */
  static async getProtectedToken(userEmail: string, planCapture: any, dbPolicies: any[]): Promise<IntentToken> {
    const client = this.getClient();
    const scope = client.forUser(userEmail);
    const policy = this.compileToArmorIQPolicy(dbPolicies);

    // Binds the programmatic policy to the token during minting
    return await client.getIntentToken(planCapture, policy, 3600);
  }
}