"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import {
  TOGGLE_ERRORS,
  normalizeToggleInput,
  type TogglePolicyResult,
} from "@/lib/policies/toggle";
import { invalidatePolicyCache } from "@/lib/policies/policy-cache";

/**
 * Enable or disable one policy rule for the signed-in user.
 *
 * These toggles decide which rules are compiled into the guardrail that gates
 * pull requests (`ArmorIQService.compileToArmorIQPolicy` in `page.tsx`), so
 * four things about the previous thirty-line version mattered (#660):
 *
 * 1. It took the *previous* state and wrote `!currentState`, discarding the
 *    state the user actually asked for. See `@/lib/policies/toggle` — a
 *    double-click wrote the same value twice and the switch silently
 *    disagreed with the database.
 * 2. `if (!session?.user?.id) return;` returned `undefined`, exactly like the
 *    success path, so an expired session looked like a save that worked.
 * 3. `formData.get("templateId") as string` asserted away `null`, so a missing
 *    field reached Prisma as a foreign-key violation thrown out of a server
 *    action.
 * 4. Nothing was written to `AuditLog`, while triage, repository sync and every
 *    admin action are recorded. Turning off the rule that blocks critical
 *    findings is a security decision, and there was no way to tell afterwards
 *    whether it had been off at the time, or turned off, or by whom.
 */
export async function togglePolicy(input: unknown): Promise<TogglePolicyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: TOGGLE_ERRORS.unauthenticated };
  }
  const userId = session.user.id;

  const parsed = normalizeToggleInput(input);
  if (!parsed) {
    return { ok: false, error: TOGGLE_ERRORS.invalidInput };
  }

  const { templateId, isActive } = parsed;

  // Confirm the template exists before upserting, so a stale or bogus id
  // returns a message rather than a foreign-key violation. The name is needed
  // for the audit entry anyway, so this costs nothing extra.
  const template = await prisma.policyTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, name: true, severity: true },
  });

  if (!template) {
    return { ok: false, error: TOGGLE_ERRORS.notFound };
  }

  try {
    await prisma.$transaction(async (tx: any) => {
      await tx.userPolicyToggle.upsert({
        where: {
          userId_policyTemplateId: {
            userId,
            policyTemplateId: templateId,
          },
        },
        // The desired state, written directly. Applying the same request twice
        // now lands on the same value instead of flipping back and forth.
        update: { isActive },
        create: {
          userId,
          policyTemplateId: templateId,
          isActive,
        },
      });

      await tx.auditLog.create({
        data: sanitizeAuditLogInput({
          userId,
          action: "POLICY_TOGGLE",
          resource: `policy:${template.name}`,
          decision: isActive ? "ENABLED" : "DISABLED",
          metadata: {
            policyTemplateId: template.id,
            policyName: template.name,
            severity: template.severity,
            isActive,
          },
        }),
      });
    });
  } catch (err) {
    console.error("[Policies] Failed to toggle rule:", (err as Error)?.message);
    return { ok: false, error: TOGGLE_ERRORS.failed };
  }

  revalidatePath("/dashboard/policies");
  revalidatePath("/dashboard/audit");

  // Invalidate the Redis policy cache so the next scan picks up the change
  // immediately rather than waiting for the TTL to expire.
  await invalidatePolicyCache(userId);

  return { ok: true, isActive };
}

export interface EditPolicyResult {
  ok: boolean;
  error?: string;
  versionNumber?: number;
}

/**
 * Edit a policy's description and severity.
 * Atomically updates the policy template, records a new immutable PolicyVersion row,
 * invalidates policy cache, and logs to AuditLog.
 */
export async function editPolicy(input: unknown): Promise<EditPolicyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Your session has expired. Sign in again to edit policies." };
  }
  const userId = session.user.id;

  const parsed = (await import("@/lib/policies/versioning")).editPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Invalid policy edit data." };
  }

  const { templateId, description, severity, action } = parsed.data;

  try {
    const versionNumber = await prisma.$transaction(async (tx: any) => {
      const template = await tx.policyTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error("POLICY_NOT_FOUND");
      }

      // Determine next version number for this template
      const latestVersion = await tx.policyVersion.findFirst({
        where: { policyTemplateId: templateId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });

      const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;

      // Update the template
      await tx.policyTemplate.update({
        where: { id: templateId },
        data: {
          description,
          severity: severity as any,
          ...(action ? { action } : {}),
        },
      });

      // Record immutable version
      await tx.policyVersion.create({
        data: {
          policyTemplateId: templateId,
          userId,
          versionNumber: nextVersionNumber,
          name: template.name,
          description,
          severity: severity as any,
          action: action || template.action,
          rules: template.rules,
        },
      });

      // Audit log entry
      if (tx.auditLog && typeof tx.auditLog.create === "function") {
        await tx.auditLog.create({
          data: sanitizeAuditLogInput({
            userId,
            action: "POLICY_EDIT",
            resource: `policy:${template.name}`,
            decision: "UPDATED",
            metadata: {
              policyTemplateId: template.id,
              policyName: template.name,
              versionNumber: nextVersionNumber,
              oldSeverity: template.severity,
              newSeverity: severity,
            },
          }),
        });
      }

      return nextVersionNumber;
    });

    revalidatePath("/dashboard/policies");
    revalidatePath("/dashboard/audit");
    await invalidatePolicyCache(userId);

    return { ok: true, versionNumber };
  } catch (err: any) {
    if (err?.message === "POLICY_NOT_FOUND") {
      return { ok: false, error: "That policy no longer exists." };
    }
    console.error("[Policies] Failed to edit policy:", err?.message || err);
    return { ok: false, error: "Failed to update policy. Please try again." };
  }
}

export interface RollbackPolicyResult {
  ok: boolean;
  error?: string;
  versionNumber?: number;
}

/**
 * Rollback a policy to a previous version.
 * Does not delete or rewrite history: restores the content by creating a new version
 * and records an audit log entry.
 */
export async function rollbackPolicy(input: unknown): Promise<RollbackPolicyResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "Your session has expired. Sign in again to rollback policies." };
  }
  const userId = session.user.id;

  const parsed = (await import("@/lib/policies/versioning")).rollbackPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid rollback request." };
  }

  const { templateId, versionId } = parsed.data;

  try {
    const nextVersionNumber = await prisma.$transaction(async (tx: any) => {
      const template = await tx.policyTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error("POLICY_NOT_FOUND");
      }

      // Security check: users can only see and restore versions of their own / accessible policies
      const targetVersion = await tx.policyVersion.findUnique({
        where: { id: versionId },
      });

      if (!targetVersion || targetVersion.policyTemplateId !== templateId) {
        throw new Error("VERSION_NOT_FOUND");
      }

      // Check if user has access to this policy via userPolicyToggle or ownership
      const userToggle = await tx.userPolicyToggle.findFirst({
        where: { userId, policyTemplateId: templateId },
      });

      // If user hasn't toggled yet, ensure the template is accessible to them
      if (!userToggle && !template.isDefault) {
        // Also check if user was the creator/editor of any version
        const userHasVersion = await tx.policyVersion.findFirst({
          where: { userId, policyTemplateId: templateId },
        });
        if (!userHasVersion) {
          throw new Error("FORBIDDEN");
        }
      }

      const latestVersion = await tx.policyVersion.findFirst({
        where: { policyTemplateId: templateId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });

      const newVersionNum = (latestVersion?.versionNumber ?? 0) + 1;

      // Update template with restored version's properties
      await tx.policyTemplate.update({
        where: { id: templateId },
        data: {
          description: targetVersion.description,
          severity: targetVersion.severity,
          action: targetVersion.action,
          rules: targetVersion.rules,
        },
      });

      // Create a brand new version representing the restoration (history is never rewritten!)
      await tx.policyVersion.create({
        data: {
          policyTemplateId: templateId,
          userId,
          versionNumber: newVersionNum,
          name: targetVersion.name,
          description: targetVersion.description,
          severity: targetVersion.severity,
          action: targetVersion.action,
          rules: targetVersion.rules,
        },
      });

      // Audit log entry
      if (tx.auditLog && typeof tx.auditLog.create === "function") {
        await tx.auditLog.create({
          data: sanitizeAuditLogInput({
            userId,
            action: "POLICY_ROLLBACK",
            resource: `policy:${template.name}`,
            decision: "RESTORED",
            metadata: {
              policyTemplateId: template.id,
              policyName: template.name,
              restoredFromVersionNumber: targetVersion.versionNumber,
              newVersionNumber: newVersionNum,
            },
          }),
        });
      }

      return newVersionNum;
    });

    revalidatePath("/dashboard/policies");
    revalidatePath("/dashboard/audit");
    await invalidatePolicyCache(userId);

    return { ok: true, versionNumber: nextVersionNumber };
  } catch (err: any) {
    if (err?.message === "POLICY_NOT_FOUND" || err?.message === "VERSION_NOT_FOUND") {
      return { ok: false, error: "The requested policy or version could not be found." };
    }
    if (err?.message === "FORBIDDEN") {
      return { ok: false, error: "You do not have permission to restore this policy." };
    }
    console.error("[Policies] Failed to rollback policy:", err?.message || err);
    return { ok: false, error: "Failed to rollback policy. Please try again." };
  }
}

/**
 * Fetch version history for a given policy template, scoped to authorized users.
 */
export async function getPolicyVersions(templateId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }
  const userId = session.user.id;

  // Confirm user has access
  const template = await prisma.policyTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new Error("Policy not found");
  }

  const userToggle = await prisma.userPolicyToggle.findFirst({
    where: { userId, policyTemplateId: templateId },
  });

  if (!userToggle && !template.isDefault) {
    const userHasVersion = await prisma.policyVersion.findFirst({
      where: { userId, policyTemplateId: templateId },
    });
    if (!userHasVersion) {
      throw new Error("Unauthorized");
    }
  }

  const versions = await prisma.policyVersion.findMany({
    where: { policyTemplateId: templateId },
    orderBy: { versionNumber: "desc" },
    include: {
      editor: {
        select: {
          id: true,
          name: true,
          email: true,
          codename: true,
        },
      },
    },
  });

  return versions.map((v: any) => ({
    id: v.id,
    policyTemplateId: v.policyTemplateId,
    versionNumber: v.versionNumber,
    name: v.name,
    description: v.description,
    severity: v.severity,
    action: v.action,
    rules: v.rules,
    createdAt: v.createdAt.toISOString(),
    editor: v.editor,
  }));
}
