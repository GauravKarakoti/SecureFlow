"use server";

import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { createLogger } from "@/lib/logger";
import {
  codenameTakenError,
  isCodenameConflict,
  validateCodename,
} from "@/lib/codename/normalize";

const log = createLogger({ context: { component: "codename-ceremony" } });

export interface SetCodenameResult {
  success: boolean;
  error?: string;
  codename?: string;
}

/**
 * Claim a crew codename.
 *
 * Three things changed here (#646), all downstream of the same problem: the
 * uniqueness check and the constraint that actually enforces uniqueness did not
 * agree with each other.
 *
 * 1. **Normalisation is total.** `@/lib/codename/normalize` gives every accepted
 *    input exactly one canonical spelling, so the case-sensitive `@unique` index
 *    now enforces the same rule the case-insensitive application check claims
 *    to. Previously only a single alphabetic word was canonicalised, and
 *    `Tokyo  Two` was a different codename from `Tokyo Two`.
 *
 * 2. **The lost race is handled.** The pre-check is still worth doing — it is
 *    the path that produces a good message for the overwhelmingly common case —
 *    but it is advisory, not a guarantee. Nothing serialises it against the
 *    write, so two recruits submitting the same codename both see it pass. The
 *    constraint is the real arbiter, and a `P2002` from it is now reported as
 *    "already taken" rather than as a vault failure with the advice to try
 *    again, which for the same codename fails forever.
 *
 * 3. **The audit entry goes through the minimiser**, like every other write in
 *    the project, and reads the previous codename from the row rather than from
 *    the session — the session carries whatever was in the JWT when the page
 *    loaded, which for a recruit who has just been redirected here is usually
 *    nothing at all.
 */
export async function setCrewCodename(rawCodename: string): Promise<SetCodenameResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return {
      success: false,
      error: "Authentication required to participate in the Naming Ceremony.",
    };
  }

  const userId = session.user.id;

  const validation = validateCodename(rawCodename);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }

  const { codename } = validation;

  // Advisory pre-check. It cannot be authoritative — nothing holds a lock
  // between here and the update — but it produces a clear message without
  // burning a failed write, which is what happens in almost every real
  // collision.
  const existing = await prisma.user.findFirst({
    where: {
      codename: { equals: codename, mode: "insensitive" },
      NOT: { id: userId },
    },
    select: { id: true },
  });

  if (existing) {
    return { success: false, error: codenameTakenError(codename) };
  }

  // Read from the row, not the session: `session.user.codename` is whatever was
  // in the token when the page rendered, so the audit trail's "previous" value
  // was routinely stale or absent.
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { codename: true },
  });

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { codename },
    });
  } catch (err) {
    // The authoritative answer. Reaching here means the pre-check passed and
    // someone else committed the same codename first.
    if (isCodenameConflict(err)) {
      log.info("Codename claim lost a race to the unique constraint", { userId });
      return { success: false, error: codenameTakenError(codename) };
    }

    log.error("Failed to update crew codename", {
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      success: false,
      error: "Failed to secure codename in Vault registry. Please try again.",
    };
  }

  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "CREW_CODENAME_ASSIGNED",
        resource: `User:${userId}`,
        decision: "PASS",
        metadata: {
          assignedCodename: codename,
          previousCodename: current?.codename ?? null,
        },
      }),
    });
  } catch (err) {
    // Non-blocking: the codename is already committed, and failing the request
    // now would tell the user their claim did not work when it did.
    log.warn("Failed to write the codename audit entry", {
      userId,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  revalidatePath("/dashboard");
  revalidatePath("/setup/codename");

  return { success: true, codename };
}
