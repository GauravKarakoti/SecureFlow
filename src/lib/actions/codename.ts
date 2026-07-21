"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";

export interface UpdateCodenameResult {
  ok: boolean;
  error?: string;
}

/**
 * Server action to update the authenticated user's codename.
 * Validates uniqueness and logs the event in the AuditLog.
 */
export async function updateCodename(codename: string): Promise<UpdateCodenameResult> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId && process.env.NEXT_PUBLIC_MOCK_AUTH !== "true") {
    return { ok: false, error: "Not authenticated" };
  }

  const activeUserId = userId || "mock-nocodename-id";
  const trimmed = codename.trim();

  if (!trimmed) {
    return { ok: false, error: "Codename cannot be empty" };
  }

  // Limit characters to alpha-numeric, spaces, and hyphens (city name style)
  const cityRegex = /^[a-zA-Z0-9\s-]+$/;
  if (!cityRegex.test(trimmed)) {
    return { ok: false, error: "Codename must contain only letters, numbers, spaces, and hyphens" };
  }

  if (trimmed.length < 2 || trimmed.length > 20) {
    return { ok: false, error: "Codename must be between 2 and 20 characters" };
  }

  // Handle Mock Database Mode
  if (process.env.NEXT_PUBLIC_MOCK_DB === "true") {
    // If it's a mock database, skip actual database operations
    return { ok: true };
  }

  try {
    // Verify codename is unique (case-insensitive check)
    const existing = await prisma.user.findFirst({
      where: {
        codename: {
          equals: trimmed,
          mode: "insensitive",
        },
      },
    });

    if (existing && existing.id !== activeUserId) {
      return { ok: false, error: "This codename is already taken by another crew member" };
    }

    // Update user codename in the database
    await prisma.user.update({
      where: { id: activeUserId },
      data: { codename: trimmed },
    });

    // Create Audit Log entry
    await prisma.auditLog.create({
      data: {
        userId: activeUserId,
        action: "UPDATE_CODENAME",
        resource: `user:${activeUserId}`,
        decision: trimmed,
        metadata: {
          codename: trimmed,
        },
      },
    });

    return { ok: true };
  } catch (err: any) {
    console.error("Failed to update codename:", err);
    return { ok: false, error: "An unexpected database error occurred" };
  }
}
