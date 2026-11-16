import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { MAX_POLICY_FILE_BYTES, validatePolicyImportPayload } from "@/lib/policies/export-import";
import { invalidatePolicyCache } from "@/lib/policies/policy-cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

/**
 * POST /api/policies/import
 * Applies the validated policy import set to the database within a transaction.
 */
async function postHandler(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }

  const userId = session.user.id;

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_FILE_BYTES) {
    throw new AppError("Policy file exceeds maximum allowed size (1 MB)", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError("Malformed JSON file", 400);
  }

  const validation = validatePolicyImportPayload(body);
  if (!validation.success || !validation.data) {
    throw new AppError(validation.error || "Invalid policy file", 400);
  }

  const incomingPolicies = validation.data.policies;

  const results = await prisma.$transaction(async (tx: any) => {
    const existingTemplates: Array<{
      id: string;
      name: string;
      description: string;
      severity: string;
      action: string;
      rules: any;
      complianceTags: string[];
      isDefault: boolean;
    }> = await tx.policyTemplate.findMany();
    const existingMap = new Map(existingTemplates.map((t) => [t.name.trim().toLowerCase(), t]));

    let createdCount = 0;
    let updatedCount = 0;

    for (const policy of incomingPolicies) {
      const existing = existingMap.get(policy.name.trim().toLowerCase());

      let templateId: string;

      if (existing) {
        // Update template details if needed
        await tx.policyTemplate.update({
          where: { id: existing.id },
          data: {
            description: policy.description,
            severity: policy.severity,
            action: policy.action ?? existing.action,
            rules: (policy.rules as any) ?? existing.rules,
            complianceTags: policy.complianceTags ?? existing.complianceTags,
          },
        });
        templateId = existing.id;
        updatedCount++;
      } else {
        // Create new policy template
        const created = await tx.policyTemplate.create({
          data: {
            name: policy.name,
            description: policy.description,
            severity: policy.severity,
            action: policy.action ?? "REVIEW REQUIRED",
            rules: (policy.rules as any) ?? [],
            complianceTags: policy.complianceTags ?? [],
            isDefault: policy.enabled,
          },
        });
        templateId = created.id;
        createdCount++;
      }

      // Upsert the user's specific policy toggle
      await tx.userPolicyToggle.upsert({
        where: {
          userId_policyTemplateId: {
            userId,
            policyTemplateId: templateId,
          },
        },
        update: { isActive: policy.enabled },
        create: {
          userId,
          policyTemplateId: templateId,
          isActive: policy.enabled,
        },
      });
    }

    // Record audit log entry
    if (tx.auditLog && typeof tx.auditLog.create === "function") {
      await tx.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "POLICY_IMPORT",
          resource: `policies:${incomingPolicies.length}`,
          decision: "SUCCESS",
          metadata: {
            totalPolicies: incomingPolicies.length,
            createdCount,
            updatedCount,
          },
        }),
      });
    }

    return { createdCount, updatedCount, total: incomingPolicies.length };
  });

  // Invalidate Redis policy cache for user
  await invalidatePolicyCache(userId);

  return NextResponse.json({
    success: true,
    ...results,
  });
}

export const POST = withRateLimit(
  withErrorHandler(postHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "policies:import" },
);
