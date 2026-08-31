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

  return { ok: true, isActive };
}
