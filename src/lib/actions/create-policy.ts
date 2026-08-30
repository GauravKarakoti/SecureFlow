"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

export interface CreatePolicyResult {
  ok: boolean;
  error?: string;
  policyId?: string;
}

const SEVERITY_OPTIONS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
const ACTION_OPTIONS = ["BLOCK", "REVIEW REQUIRED", "ALERT ONLY"] as const;

export interface PolicyFormInput {
  name: string;
  description: string;
  severity: string;
  action: string;
  conditions: string[];
}

function validate(input: PolicyFormInput): string | null {
  if (!input.name || input.name.trim().length < 3) return "Policy name must be at least 3 characters.";
  if (input.name.trim().length > 100) return "Policy name must be under 100 characters.";
  if (!input.description || input.description.trim().length < 10) return "Description must be at least 10 characters.";
  if (input.description.trim().length > 500) return "Description must be under 500 characters.";
  if (!SEVERITY_OPTIONS.includes(input.severity as any)) return "Invalid severity level.";
  if (!ACTION_OPTIONS.includes(input.action as any)) return "Invalid action type.";
  const validConditions = input.conditions.filter((c) => c.trim().length > 0);
  if (validConditions.length === 0) return "At least one rule condition is required.";
  if (validConditions.some((c) => c.length > 300)) return "Each condition must be under 300 characters.";
  return null;
}

export async function createCustomPolicy(input: PolicyFormInput): Promise<CreatePolicyResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in to create policies." };

  const error = validate(input);
  if (error) return { ok: false, error };

  const userId = session.user.id;
  const conditions = input.conditions.filter((c) => c.trim().length > 0);

  try {
    const template = await prisma.policyTemplate.create({
      data: {
        name: input.name.trim(),
        description: input.description.trim(),
        severity: input.severity as any,
        action: input.action,
        isDefault: false,
        rules: { conditions },
      },
    });

    // Auto-enable for the creating user
    await prisma.userPolicyToggle.create({
      data: {
        userId,
        policyTemplateId: template.id,
        isActive: true,
      },
    });

    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "POLICY_CREATED",
        resource: `policy:${template.name}`,
        decision: "ENABLED",
        metadata: {
          policyTemplateId: template.id,
          policyName: template.name,
          severity: input.severity,
          action: input.action,
          conditionCount: conditions.length,
        },
      }),
    });

    revalidatePath("/dashboard/policies");
    revalidatePath("/dashboard/audit");

    return { ok: true, policyId: template.id };
  } catch (err: any) {
    console.error("[Policies] Failed to create custom policy:", err?.message);
    return { ok: false, error: "Failed to create policy. Please try again." };
  }
}
