"use server";

import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export interface SetCodenameResult {
  success: boolean;
  error?: string;
  codename?: string;
}

export async function setCrewCodename(rawCodename: string): Promise<SetCodenameResult> {
  const session = await auth();

  if (!session?.user?.id) {
    return { success: false, error: "Authentication required to participate in the Naming Ceremony." };
  }

  const trimmed = (rawCodename || "").trim();

  if (!trimmed) {
    return { success: false, error: "Codename cannot be empty." };
  }

  if (trimmed.length < 2 || trimmed.length > 30) {
    return { success: false, error: "Codename must be between 2 and 30 characters long." };
  }

  // Only allow alphanumeric characters, spaces, and hyphens/underscores
  if (!/^[a-zA-Z0-9 _-]+$/.test(trimmed)) {
    return { success: false, error: "Codename can only contain letters, numbers, spaces, hyphens, and underscores." };
  }

  // Capitalize properly for consistency (e.g. "tokyo" -> "Tokyo") if single word
  const formatted = trimmed.length > 1 && /^[a-zA-Z]+$/.test(trimmed)
    ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
    : trimmed;

  // Check uniqueness (case-insensitive where possible or direct unique check)
  const existing = await prisma.user.findFirst({
    where: {
      codename: {
        equals: formatted,
        mode: "insensitive",
      },
      NOT: {
        id: session.user.id,
      },
    },
  });

  if (existing) {
    return {
      success: false,
      error: `Codename "${formatted}" is already taken by an active crew member. Choose another city.`,
    };
  }

  try {
    await prisma.user.update({
      where: { id: session.user.id },
      data: { codename: formatted },
    });

    try {
      await prisma.auditLog.create({
        data: {
          userId: session.user.id,
          action: "CREW_CODENAME_ASSIGNED",
          resource: `User:${session.user.id}`,
          decision: "PASS",
          metadata: {
            assignedCodename: formatted,
            previousCodename: session.user.codename || null,
          },
        },
      });
    } catch {
      // Audit log non-blocking
    }

    revalidatePath("/dashboard");
    revalidatePath("/setup/codename");
    return { success: true, codename: formatted };
  } catch (err: any) {
    console.error("Failed to update crew codename:", err);
    return { success: false, error: "Failed to secure codename in Vault registry. Please try again." };
  }
}
