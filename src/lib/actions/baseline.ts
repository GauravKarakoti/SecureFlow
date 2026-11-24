"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { assertCan } from "@/lib/auth/permissions";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import {
  clampBaselineFileLimit,
  canRunBaselineScan,
  isBaselineScanDue,
  executeBaselineScan,
  type BaselineFrequency,
} from "@/lib/baseline/baseline-scanner";

/**
 * Updates baseline scanning configuration for a repository.
 */
export async function updateRepositoryBaselineConfig(
  repositoryId: string,
  settings: {
    enabled?: boolean;
    frequency?: string;
    fileLimit?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
  });

  if (!repo) {
    return { ok: false, error: "Repository not found or access denied" };
  }

  const validFrequencies: BaselineFrequency[] = ["daily", "weekly", "monthly"];
  const cleanFrequency =
    settings.frequency && validFrequencies.includes(settings.frequency as BaselineFrequency)
      ? settings.frequency
      : undefined;

  const cleanFileLimit =
    settings.fileLimit !== undefined ? clampBaselineFileLimit(settings.fileLimit) : undefined;

  await prisma.repository.update({
    where: { id: repositoryId },
    data: {
      ...(settings.enabled !== undefined ? { baselineScanEnabled: settings.enabled } : {}),
      ...(cleanFrequency ? { baselineFrequency: cleanFrequency } : {}),
      ...(cleanFileLimit !== undefined ? { baselineFileLimit: cleanFileLimit } : {}),
    },
  });

  // Audit log entry
  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "REPOSITORY_BASELINE_CONFIG_UPDATE",
        resource: `repository:${repo.fullName}`,
        metadata: {
          repositoryId,
          settings,
        },
      }),
    });
  } catch (err) {
    console.warn("[Baseline] Audit log recording failed:", err);
  }

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/findings");

  return { ok: true };
}

/**
 * Triggers a baseline scan for a repository.
 */
export async function triggerRepositoryBaselineScan(
  repositoryId: string,
  options: { force?: boolean } = {},
): Promise<{ ok: boolean; scanResultId?: string; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
  });

  if (!repo) {
    return { ok: false, error: "Repository not found or access denied" };
  }

  const check = canRunBaselineScan(repo, { force: options.force });
  if (!check.allowed) {
    return { ok: false, error: check.reason };
  }

  try {
    const result = await executeBaselineScan({
      repositoryId: repo.id,
      repositoryFullName: repo.fullName,
      force: options.force,
    });

    revalidatePath("/dashboard/settings");
    revalidatePath("/dashboard/findings");

    return { ok: true, scanResultId: result.scanResultId };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Failed to execute baseline scan" };
  }
}

/**
 * Retrieves baseline scan configuration and status for a repository.
 */
export async function getRepositoryBaselineConfig(repositoryId: string) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
    select: {
      id: true,
      fullName: true,
      baselineScanEnabled: true,
      baselineFrequency: true,
      baselineFileLimit: true,
      lastBaselineScanAt: true,
      lastBaselineScanStatus: true,
    },
  });

  if (!repo) {
    return null;
  }

  return {
    ...repo,
    isDue: isBaselineScanDue(repo),
  };
}

/**
 * Runs scheduled baseline scans across all repositories that are due.
 */
export async function runScheduledBaselineScans(
  options: { force?: boolean } = {},
): Promise<{ dispatched: number; errors: number }> {
  const repos = await prisma.repository.findMany({
    where: options.force ? {} : { baselineScanEnabled: true, isActive: true },
    select: {
      id: true,
      fullName: true,
      baselineScanEnabled: true,
      baselineFrequency: true,
      baselineFileLimit: true,
      lastBaselineScanAt: true,
    },
  });

  let dispatched = 0;
  let errors = 0;

  for (const repo of repos) {
    if (!options.force && !isBaselineScanDue(repo)) {
      continue;
    }

    try {
      await executeBaselineScan({
        repositoryId: repo.id,
        repositoryFullName: repo.fullName,
        force: options.force,
      });
      dispatched++;
    } catch (err) {
      errors++;
      console.warn(`[ScheduledBaseline] Failed to scan ${repo.fullName}:`, err);
    }
  }

  return { dispatched, errors };
}
