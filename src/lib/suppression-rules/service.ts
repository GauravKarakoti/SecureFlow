/**
 * Suppression Rules Database Service (#1891).
 *
 * Provides database queries and mutations for installation-wide suppression rules,
 * 30-day suppression metric aggregation, and audit logging.
 */

import prisma from "@/lib/prisma";
import type { SuppressionRule } from "@prisma/client";

export interface SuppressionRuleWithStats extends SuppressionRule {
  thirtyDaySuppressionCount: number;
}

export interface CreateSuppressionRuleInput {
  name: string;
  description?: string | null;
  scope: "ALL" | "SELECTED";
  repositoryIds?: string[];
  matchPolicy?: string | null;
  matchCategory?: string | null;
  pathGlob?: string | null;
  reason: string;
  expiresAt?: Date | string | null;
}

export interface UpdateSuppressionRuleInput {
  name?: string;
  description?: string | null;
  scope?: "ALL" | "SELECTED";
  repositoryIds?: string[];
  matchPolicy?: string | null;
  matchCategory?: string | null;
  pathGlob?: string | null;
  reason?: string;
  expiresAt?: Date | string | null;
}

/**
 * Fetches all suppression rules with their 30-day suppression count.
 */
export async function getSuppressionRulesWithStats(): Promise<SuppressionRuleWithStats[]> {
  const rules = await prisma.suppressionRule.findMany({
    orderBy: { createdAt: "desc" },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let countsByRuleId: Record<string, number> = {};

  try {
    const eventCounts = await prisma.suppressionRuleEvent.groupBy({
      by: ["ruleId"],
      where: {
        createdAt: { gte: thirtyDaysAgo },
      },
      _count: { id: true },
    });

    countsByRuleId = Object.fromEntries(
      eventCounts.map((ec: any) => [ec.ruleId, ec._count?.id ?? 0]),
    );
  } catch (error) {
    console.error("[SuppressionRules] Failed to fetch 30-day event counts:", error);
  }

  return rules.map((rule: SuppressionRule) => ({
    ...rule,
    thirtyDaySuppressionCount: countsByRuleId[rule.id] ?? 0,
  }));
}

/**
 * Fetches active suppression rules applicable for scans.
 */
export async function getActiveSuppressionRules(
  now: Date = new Date(),
): Promise<SuppressionRule[]> {
  return await prisma.suppressionRule.findMany({
    where: {
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
}

/**
 * Records audit logs and suppression events when findings are suppressed at scan time.
 */
export async function recordSuppressionRuleEvents(
  events: Array<{
    ruleId: string;
    repositoryId?: string | null;
    findingFingerprint?: string | null;
    fileLocation?: string | null;
  }>,
): Promise<void> {
  if (events.length === 0) return;

  try {
    await prisma.suppressionRuleEvent.createMany({
      data: events.map((e) => ({
        ruleId: e.ruleId,
        repositoryId: e.repositoryId || null,
        findingFingerprint: e.findingFingerprint || null,
        fileLocation: e.fileLocation || null,
      })),
    });
  } catch (error) {
    console.error("[SuppressionRules] Failed to record suppression events:", error);
  }
}

/**
 * Creates a new suppression rule and records an audit log entry.
 */
export async function createSuppressionRule(
  input: CreateSuppressionRuleInput,
  adminUserId: string,
): Promise<SuppressionRule> {
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  const rule = await prisma.suppressionRule.create({
    data: {
      name: input.name.trim(),
      description: input.description?.trim() || null,
      scope: input.scope,
      repositoryIds: input.repositoryIds || [],
      matchPolicy: input.matchPolicy?.trim() || null,
      matchCategory: input.matchCategory?.trim() || null,
      pathGlob: input.pathGlob?.trim() || null,
      reason: input.reason.trim(),
      expiresAt,
      createdById: adminUserId,
    },
  });

  try {
    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: "SUPPRESSION_RULE_CREATE",
        resource: rule.id,
        metadata: {
          ruleId: rule.id,
          name: rule.name,
          scope: rule.scope,
          reason: rule.reason,
          matchCategory: rule.matchCategory,
          matchPolicy: rule.matchPolicy,
          pathGlob: rule.pathGlob,
          expiresAt: rule.expiresAt?.toISOString() || null,
        },
      },
    });
  } catch (auditError) {
    console.error("[SuppressionRules] Failed to create audit log for rule creation:", auditError);
  }

  return rule;
}

/**
 * Updates an existing suppression rule and records an audit log entry.
 */
export async function updateSuppressionRule(
  id: string,
  input: UpdateSuppressionRuleInput,
  adminUserId: string,
): Promise<SuppressionRule> {
  const data: Record<string, any> = {};

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.description !== undefined) data.description = input.description?.trim() || null;
  if (input.scope !== undefined) data.scope = input.scope;
  if (input.repositoryIds !== undefined) data.repositoryIds = input.repositoryIds;
  if (input.matchPolicy !== undefined) data.matchPolicy = input.matchPolicy?.trim() || null;
  if (input.matchCategory !== undefined) data.matchCategory = input.matchCategory?.trim() || null;
  if (input.pathGlob !== undefined) data.pathGlob = input.pathGlob?.trim() || null;
  if (input.reason !== undefined) data.reason = input.reason.trim();
  if (input.expiresAt !== undefined) {
    data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  }

  const updatedRule = await prisma.suppressionRule.update({
    where: { id },
    data,
  });

  try {
    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: "SUPPRESSION_RULE_UPDATE",
        resource: updatedRule.id,
        metadata: {
          ruleId: updatedRule.id,
          name: updatedRule.name,
          scope: updatedRule.scope,
          reason: updatedRule.reason,
          matchCategory: updatedRule.matchCategory,
          matchPolicy: updatedRule.matchPolicy,
          pathGlob: updatedRule.pathGlob,
          expiresAt: updatedRule.expiresAt?.toISOString() || null,
        },
      },
    });
  } catch (auditError) {
    console.error("[SuppressionRules] Failed to create audit log for rule update:", auditError);
  }

  return updatedRule;
}

/**
 * Deletes a suppression rule and records an audit log entry.
 */
export async function deleteSuppressionRule(
  id: string,
  adminUserId: string,
): Promise<SuppressionRule> {
  const deletedRule = await prisma.suppressionRule.delete({
    where: { id },
  });

  try {
    await prisma.auditLog.create({
      data: {
        userId: adminUserId,
        action: "SUPPRESSION_RULE_DELETE",
        resource: deletedRule.id,
        metadata: {
          ruleId: deletedRule.id,
          name: deletedRule.name,
          reason: deletedRule.reason,
        },
      },
    });
  } catch (auditError) {
    console.error("[SuppressionRules] Failed to create audit log for rule deletion:", auditError);
  }

  return deletedRule;
}
