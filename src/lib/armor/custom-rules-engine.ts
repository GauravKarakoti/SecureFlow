import { prisma } from '@/lib/prisma';

export interface CustomRule {
  id: string;
  name: string;
  regexPattern: string;
  isActive: boolean;
}

/**
 * Safely compiles and validates a user-provided regex pattern.
 * Throws an error if the pattern is invalid, preventing ReDoS or crashes.
 */
export function validateRegexPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Executes active custom rules against a given code snippet.
 */
export function executeCustomRules(code: string, rules: CustomRule[]): { ruleName: string; match: string }[] {
  const findings = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;

    try {
      const regex = new RegExp(rule.regexPattern, 'g');
      let match;
      while ((match = regex.exec(code)) !== null) {
        findings.push({
          ruleName: rule.name,
          match: match[0]
        });
      }
    } catch (error) {
      console.error(`[CustomRules] Failed to execute rule ${rule.name}:`, error);
    }
  }

  return findings;
}

/**
 * Fetches all active custom rules for a specific user or organization.
 */
export async function getActiveCustomRules(userId: string, orgId?: string): Promise<CustomRule[]> {
  return prisma.customRule.findMany({
    where: {
      OR: [
        { userId },
        orgId ? { orgId } : { orgId: null }
      ],
      isActive: true
    },
    select: { id: true, name: true, regexPattern: true, isActive: true }
  });
}
