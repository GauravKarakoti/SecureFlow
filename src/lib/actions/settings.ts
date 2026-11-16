"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { assertSlackWebhookUrl, sendSlackAlert } from "@/lib/integrations/slack";
import { assertTeamsWebhookUrl, sendTeamsAlert, buildTeamsAlert } from "@/lib/integrations/teams";
import { buildBlockedSlackAlert } from "@/lib/integrations/notification-dispatcher";

export async function updateSlackWebhook(url: string | null) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  // Strict Slack webhook URL validation
  if (url !== null && url.trim() !== "") {
    assertSlackWebhookUrl(url);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      slackWebhookUrl: url && url.trim() !== "" ? url.trim() : null,
    },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

export async function getSlackWebhook() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { slackWebhookUrl: true },
  });

  return user?.slackWebhookUrl || null;
}

export async function updateTeamsWebhook(url: string | null) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  // Strict Teams webhook URL validation
  if (url !== null && url.trim() !== "") {
    assertTeamsWebhookUrl(url);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      teamsWebhookUrl: url && url.trim() !== "" ? url.trim() : null,
    },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

export async function getTeamsWebhook() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { teamsWebhookUrl: true },
  });

  return user?.teamsWebhookUrl || null;
}

export async function testSlackWebhook(url: string): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  try {
    assertSlackWebhookUrl(url);
    const testMsg = buildBlockedSlackAlert("SecureFlow/test-repository", 1, [
      { severity: "CRITICAL", type: "Test Finding" },
    ]);
    const ok = await sendSlackAlert(url.trim(), testMsg);
    if (!ok) {
      return { success: false, error: "Slack endpoint rejected the test payload or timed out." };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function testTeamsWebhook(url: string): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  try {
    assertTeamsWebhookUrl(url);
    const testCard = buildTeamsAlert({
      repositoryFullName: "SecureFlow/test-repository",
      prNumber: 1,
      findings: [{ severity: "CRITICAL", type: "Test Finding" }],
    });
    const ok = await sendTeamsAlert(url.trim(), testCard);
    if (!ok) {
      return {
        success: false,
        error: "Microsoft Teams endpoint rejected the test payload or timed out.",
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateVoiceAlerts(enabled: boolean): Promise<{ success: boolean }> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    throw new Error("Unauthorized");
  }

  await prisma.user.update({
    where: { id: userId },
    data: { voiceAlertsEnabled: Boolean(enabled) },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

export async function getVoiceAlerts(): Promise<boolean> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) return false;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { voiceAlertsEnabled: true },
  });

  return user?.voiceAlertsEnabled ?? false;
}

export interface RepoBadgeSetting {
  id: string;
  fullName: string;
  owner: string;
  publicBadgeEnabled: boolean;
  latestStatus?: string | null;
}

export async function getUserRepositoriesWithBadgeStatus(): Promise<RepoBadgeSetting[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const repos = await prisma.repository.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      fullName: true,
      owner: true,
      publicBadgeEnabled: true,
      pullRequests: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true },
      },
    },
    orderBy: { fullName: "asc" },
  });

  return (
    repos as Array<{
      id: string;
      fullName: string;
      owner: string;
      publicBadgeEnabled: boolean;
      pullRequests: Array<{ status: string }>;
    }>
  ).map((repo) => ({
    id: repo.id,
    fullName: repo.fullName,
    owner: repo.owner,
    publicBadgeEnabled: repo.publicBadgeEnabled,
    latestStatus: repo.pullRequests[0]?.status ?? null,
  }));
}

export async function updateRepositoryPublicBadge(
  repositoryId: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, userId },
  });

  if (!repo) {
    return { success: false, error: "Repository not found or unauthorized" };
  }

  await prisma.repository.update({
    where: { id: repositoryId },
    data: { publicBadgeEnabled: Boolean(enabled) },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}
