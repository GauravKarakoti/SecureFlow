"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  createSuppressionRule,
  updateSuppressionRule,
  renewSuppressionRule,
  deleteSuppressionRule,
  getSuppressionRulesWithStats,
  type CreateSuppressionRuleInput,
  type UpdateSuppressionRuleInput,
} from "@/lib/suppression-rules/service";

/**
 * Asserts that the current session belongs to an authenticated user with ADMIN role.
 * Non-admin users are rejected with an error.
 */
async function requireAdminSession() {
  const session = await auth();

  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    throw new Error("Forbidden: Admin role required to manage suppression rules.");
  }

  return session.user;
}

export async function getSuppressionRulesAction() {
  await requireAdminSession();
  return await getSuppressionRulesWithStats();
}

export async function createSuppressionRuleAction(input: CreateSuppressionRuleInput) {
  const adminUser = await requireAdminSession();

  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Rule name is required.");
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error("Suppression reason is required.");
  }
  if (!input.scope || !["ALL", "SELECTED"].includes(input.scope)) {
    throw new Error("Valid scope ('ALL' or 'SELECTED') is required.");
  }

  const result = await createSuppressionRule(input, adminUser.id);
  revalidatePath("/admin/suppression-rules");
  return result;
}

export async function updateSuppressionRuleAction(
  id: string,
  input: UpdateSuppressionRuleInput,
  previousExpiresAt?: Date | null,
) {
  const adminUser = await requireAdminSession();

  if (!id) {
    throw new Error("Rule ID is required.");
  }

  const result = await updateSuppressionRule(id, input, adminUser.id, previousExpiresAt);
  if (!result)
    return { error: "This rule expired or changed. Refresh the list before editing it." };
  revalidatePath("/admin/suppression-rules");
  return result;
}

export async function renewSuppressionRuleAction(id: string, expiryDate: string) {
  const adminUser = await requireAdminSession();
  if (!id) throw new Error("Rule ID is required.");

  const now = new Date();
  if (typeof expiryDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    return { error: "Choose a future expiry date (UTC)." };
  }
  const expiresAt = new Date(expiryDate);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.toISOString().slice(0, 10) !== expiryDate ||
    expiresAt <= now
  ) {
    return { error: "Choose a future expiry date (UTC)." };
  }

  const result = await renewSuppressionRule(id, expiresAt, now, adminUser.id);
  if (!result) return { error: "This rule is no longer expired. Refresh the list and try again." };
  revalidatePath("/admin/suppression-rules");
  return result;
}

export async function deleteSuppressionRuleAction(id: string) {
  const adminUser = await requireAdminSession();

  if (!id) {
    throw new Error("Rule ID is required.");
  }

  const result = await deleteSuppressionRule(id, adminUser.id);
  revalidatePath("/admin/suppression-rules");
  return result;
}
