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
      return { success: false, error: "Microsoft Teams endpoint rejected the test payload or timed out." };
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
