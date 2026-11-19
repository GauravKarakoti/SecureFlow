"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

export interface SavedViewFilters {
  severity?: string[];
  type?: string[];
  status?: string[];
  repositoryId?: string | null;
  search?: string | null;
  from?: string | null;
  to?: string | null;
  sort?: string;
}

export interface SavedViewDto {
  id: string;
  userId: string;
  name: string;
  filters: SavedViewFilters;
  createdAt: Date;
  updatedAt: Date;
}

async function requireUser(): Promise<string> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  return userId;
}

/**
 * Sanitize and whitelist filter fields so no sensitive data (tokens, snippets)
 * can ever be stored in a saved view.
 */
export function sanitizeViewFilters(filters: Record<string, unknown> = {}): SavedViewFilters {
  const sanitized: SavedViewFilters = {};

  if (Array.isArray(filters.severity)) {
    sanitized.severity = filters.severity.filter(
      (s): s is string => typeof s === "string" && s.trim() !== "",
    );
  }
  if (Array.isArray(filters.type)) {
    sanitized.type = filters.type.filter(
      (t): t is string => typeof t === "string" && t.trim() !== "",
    );
  }
  if (Array.isArray(filters.status)) {
    sanitized.status = filters.status.filter(
      (st): st is string => typeof st === "string" && st.trim() !== "",
    );
  }
  if (typeof filters.repositoryId === "string" && filters.repositoryId.trim()) {
    sanitized.repositoryId = filters.repositoryId.trim();
  }
  if (typeof filters.search === "string" && filters.search.trim()) {
    sanitized.search = filters.search.trim().slice(0, 200);
  }
  if (typeof filters.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filters.from.trim())) {
    sanitized.from = filters.from.trim();
  }
  if (typeof filters.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(filters.to.trim())) {
    sanitized.to = filters.to.trim();
  }
  if (typeof filters.sort === "string" && filters.sort.trim()) {
    sanitized.sort = filters.sort.trim();
  }

  return sanitized;
}

/**
 * Fetch all saved views belonging strictly to the authenticated user.
 */
export async function getSavedViews(): Promise<SavedViewDto[]> {
  const userId = await requireUser();

  const views = await prisma.savedView.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return views.map((v: any) => ({
    id: v.id,
    userId: v.userId,
    name: v.name,
    filters: (v.filters ?? {}) as SavedViewFilters,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }));
}

/**
 * Save a new named view for the authenticated user.
 * If a view with the same name already exists for this user, it updates it.
 */
export async function createSavedView(input: {
  name: string;
  filters: SavedViewFilters;
}): Promise<SavedViewDto> {
  const userId = await requireUser();

  const trimmedName = input.name?.trim();
  if (!trimmedName) {
    throw new Error("View name is required");
  }

  if (trimmedName.length > 80) {
    throw new Error("View name cannot exceed 80 characters");
  }

  const sanitized = sanitizeViewFilters(input.filters as Record<string, unknown>);

  const saved = await prisma.savedView.upsert({
    where: {
      userId_name: {
        userId,
        name: trimmedName,
      },
    },
    create: {
      userId,
      name: trimmedName,
      filters: sanitized as any,
    },
    update: {
      filters: sanitized as any,
    },
  });

  revalidatePath("/dashboard/findings");

  return {
    id: saved.id,
    userId: saved.userId,
    name: saved.name,
    filters: saved.filters as SavedViewFilters,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

/**
 * Delete a saved view. Enforces that only the creator of the view can delete it.
 */
export async function deleteSavedView(id: string): Promise<{ success: boolean }> {
  const userId = await requireUser();

  if (!id || typeof id !== "string") {
    throw new Error("View ID is required");
  }

  const existing = await prisma.savedView.findUnique({
    where: { id },
  });

  if (!existing) {
    throw new Error("Saved view not found");
  }

  // Permissions check: Users cannot delete other users' saved views
  if (existing.userId !== userId) {
    throw new Error("Forbidden: You do not have permission to delete this saved view");
  }

  await prisma.savedView.delete({
    where: { id },
  });

  revalidatePath("/dashboard/findings");

  return { success: true };
}
