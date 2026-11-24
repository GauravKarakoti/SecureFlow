"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { assertCan } from "@/lib/auth/permissions";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import {
  type InstallationSettingsDto,
  type EffectiveResolvedSettings,
  resolveEffectiveSettings,
  buildEffectiveGateConfig,
  LOCKABLE_SETTING_KEYS,
} from "@/lib/scanner/installation-settings";
import { parseGateLevel } from "@/lib/scanner/gate-config";
import { parseConfidence } from "@/lib/confidence";

/**
 * Fetch installation settings baseline for a given installation ID (default: "default").
 */
export async function getInstallationSettings(
  installationId: string = "default",
): Promise<InstallationSettingsDto> {
  let settings = await prisma.installationSettings.findUnique({
    where: { installationId },
  });

  if (!settings && installationId !== "default") {
    settings = await prisma.installationSettings.findUnique({
      where: { installationId: "default" },
    });
  }

  if (!settings) {
    return {
      installationId,
      gateBlockOn: null,
      gateReviewOn: null,
      minCommentConfidence: null,
      includeDefaults: null,
      skipDrafts: null,
      skipAuthors: [],
      lockedSettings: [],
    };
  }

  return {
    installationId: settings.installationId,
    gateBlockOn: (settings.gateBlockOn as any) ?? null,
    gateReviewOn: (settings.gateReviewOn as any) ?? null,
    minCommentConfidence: (settings.minCommentConfidence as any) ?? null,
    includeDefaults: settings.includeDefaults,
    skipDrafts: settings.skipDrafts,
    skipAuthors: settings.skipAuthors,
    lockedSettings: settings.lockedSettings,
  };
}

/**
 * Update installation settings baseline. Requires admin role and audits changes.
 */
export async function updateInstallationSettings(
  installationId: string = "default",
  data: Partial<InstallationSettingsDto>,
): Promise<{ ok: boolean; settings?: InstallationSettingsDto; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId || !session.user.roles?.includes("ADMIN")) {
    throw new Error("Unauthorized: Admin role required to modify installation settings");
  }

  assertCan(session.user, null, "settings:edit");

  // Filter and sanitize lockedSettings
  const validLocked = (data.lockedSettings || []).filter((k) =>
    (LOCKABLE_SETTING_KEYS as readonly string[]).includes(k),
  );

  const cleanGateBlockOn =
    data.gateBlockOn !== undefined
      ? data.gateBlockOn
        ? parseGateLevel(data.gateBlockOn)
        : null
      : undefined;
  const cleanGateReviewOn =
    data.gateReviewOn !== undefined
      ? data.gateReviewOn
        ? parseGateLevel(data.gateReviewOn)
        : null
      : undefined;
  const cleanMinConfidence =
    data.minCommentConfidence !== undefined
      ? data.minCommentConfidence
        ? parseConfidence(data.minCommentConfidence)
        : null
      : undefined;

  const previous = await prisma.installationSettings.findUnique({
    where: { installationId },
  });

  const updated = await prisma.installationSettings.upsert({
    where: { installationId },
    update: {
      ...(cleanGateBlockOn !== undefined ? { gateBlockOn: cleanGateBlockOn } : {}),
      ...(cleanGateReviewOn !== undefined ? { gateReviewOn: cleanGateReviewOn } : {}),
      ...(cleanMinConfidence !== undefined ? { minCommentConfidence: cleanMinConfidence } : {}),
      ...(data.includeDefaults !== undefined ? { includeDefaults: data.includeDefaults } : {}),
      ...(data.skipDrafts !== undefined ? { skipDrafts: data.skipDrafts } : {}),
      ...(data.skipAuthors !== undefined ? { skipAuthors: data.skipAuthors } : {}),
      ...(data.lockedSettings !== undefined ? { lockedSettings: validLocked } : {}),
      updatedBy: userId,
    },
    create: {
      installationId,
      gateBlockOn: cleanGateBlockOn ?? null,
      gateReviewOn: cleanGateReviewOn ?? null,
      minCommentConfidence: cleanMinConfidence ?? null,
      includeDefaults: data.includeDefaults ?? null,
      skipDrafts: data.skipDrafts ?? null,
      skipAuthors: data.skipAuthors ?? [],
      lockedSettings: validLocked,
      updatedBy: userId,
    },
  });

  // Record audit log entry
  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "INSTALLATION_SETTINGS_UPDATE",
        resource: `installation:${installationId}`,
        metadata: {
          installationId,
          previous: previous
            ? {
                gateBlockOn: previous.gateBlockOn,
                gateReviewOn: previous.gateReviewOn,
                minCommentConfidence: previous.minCommentConfidence,
                includeDefaults: previous.includeDefaults,
                skipDrafts: previous.skipDrafts,
                skipAuthors: previous.skipAuthors,
                lockedSettings: previous.lockedSettings,
              }
            : null,
          updated: {
            gateBlockOn: updated.gateBlockOn,
            gateReviewOn: updated.gateReviewOn,
            minCommentConfidence: updated.minCommentConfidence,
            includeDefaults: updated.includeDefaults,
            skipDrafts: updated.skipDrafts,
            skipAuthors: updated.skipAuthors,
            lockedSettings: updated.lockedSettings,
          },
        },
      }),
    });
  } catch (err) {
    console.warn("[InstallationSettings] Non-blocking audit log failure:", err);
  }

  revalidatePath("/admin/settings");
  revalidatePath("/dashboard/settings");

  return {
    ok: true,
    settings: {
      installationId: updated.installationId,
      gateBlockOn: (updated.gateBlockOn as any) ?? null,
      gateReviewOn: (updated.gateReviewOn as any) ?? null,
      minCommentConfidence: (updated.minCommentConfidence as any) ?? null,
      includeDefaults: updated.includeDefaults,
      skipDrafts: updated.skipDrafts,
      skipAuthors: updated.skipAuthors,
      lockedSettings: updated.lockedSettings,
    },
  };
}

/**
 * Resolves effective settings for a repository given its repository-level GateConfig.
 */
export async function getRepositoryEffectiveSettings(
  repoConfig?: any,
  installationId: string = "default",
): Promise<EffectiveResolvedSettings> {
  const installationSettings = await getInstallationSettings(installationId);
  return resolveEffectiveSettings(repoConfig, installationSettings);
}
