"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  createSuppressionRule,
  updateSuppressionRule,
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

export async function updateSuppressionRuleAction(id: string, input: UpdateSuppressionRuleInput) {
  const adminUser = await requireAdminSession();

  if (!id) {
    throw new Error("Rule ID is required.");
  }

  const result = await updateSuppressionRule(id, input, adminUser.id);
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
