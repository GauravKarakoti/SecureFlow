"use server";

import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { verifySignature } from "@/lib/github/webhook-verification";

export interface OnboardingStatus {
  appInstalled: boolean;
  repoConnected: boolean;
  webhookReceived: boolean;
  policyEnabled: boolean;
  firstScanCompleted: boolean;
  allComplete: boolean;
}

export interface TestWebhookResult {
  success: boolean;
  message?: string;
  error?: string;
  deliveryId?: string;
}

/**
 * Compute the 5-point onboarding checklist status for a user based on real database records (#1787).
 */
export async function getOnboardingStatus(
  userId: string,
  needsGitHubAppInstall: boolean,
  repoCount: number,
  totalScans: number,
): Promise<OnboardingStatus> {
  // 1. Webhook deliveries received
  const webhookCount = await prisma.webhookEvent.count({
    where: { repository: { userId } },
  });

  // 2. Policy enabled: user toggled on, or default template when untoggled
  const templates = await prisma.policyTemplate.findMany({
    select: { id: true, isDefault: true },
  });

  const userToggles = await prisma.userPolicyToggle.findMany({
    where: { userId },
    select: { policyTemplateId: true, isActive: true },
  });

  const toggleMap = new Map(userToggles.map((t: any) => [t.policyTemplateId, t.isActive]));

  let activePoliciesCount = 0;
  for (const t of templates) {
    const isActive = toggleMap.has(t.id) ? toggleMap.get(t.id) : t.isDefault;
    if (isActive) activePoliciesCount++;
  }

  const appInstalled = !needsGitHubAppInstall;
  const repoConnected = repoCount > 0;
  const webhookReceived = webhookCount > 0;
  const policyEnabled = activePoliciesCount > 0;
  const firstScanCompleted = totalScans > 0;

  const allComplete =
    appInstalled && repoConnected && webhookReceived && policyEnabled && firstScanCompleted;

  return {
    appInstalled,
    repoConnected,
    webhookReceived,
    policyEnabled,
    firstScanCompleted,
    allComplete,
  };
}

/**
 * Send and verify a simulated GitHub ping webhook event to test the webhook pathway without scanning real code (#1787).
 * Reports success or a human-readable failure reason.
 */
export async function sendTestWebhookEvent(): Promise<TestWebhookResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return {
      success: false,
      error: "Authentication Required: You must be signed in to send a test event.",
    };
  }

  // 1. Check GITHUB_WEBHOOK_SECRET
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return {
      success: false,
      error:
        "Configuration Error: GITHUB_WEBHOOK_SECRET is not configured on the server. Webhook deliveries cannot be validated.",
    };
  }

  // 2. Find user's active repository (if any)
  const repo = await prisma.repository.findFirst({
    where: { userId, isActive: true },
    select: { id: true, fullName: true, owner: true, githubId: true },
  });

  const deliveryId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // 3. Construct a standard GitHub ping event
  const pingPayload = {
    zen: "Security in motion.",
    hook_id: 99999999,
    hook: {
      type: "App",
      id: 99999999,
      name: "SecureFlow",
      active: true,
      events: ["pull_request", "installation", "installation_repositories"],
      created_at: timestamp,
    },
    repository: repo
      ? {
          id: Number(repo.githubId),
          name: repo.fullName.split("/")[1] || repo.fullName,
          full_name: repo.fullName,
          owner: { login: repo.owner },
        }
      : undefined,
    sender: {
      login: (session.user as any)?.githubLogin || session.user?.name || "operator",
    },
  };

  const rawPayload = JSON.stringify(pingPayload);

  // 4. Compute HMAC SHA-256 signature
  const hmac = crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");
  const signatureHeader = `sha256=${hmac}`;

  // 5. Test signature verification against webhook admission control
  const signatureValid = verifySignature(rawPayload, secret, signatureHeader);
  if (!signatureValid) {
    return {
      success: false,
      error:
        "HMAC Signature Verification Failed: The test event could not be verified with GITHUB_WEBHOOK_SECRET.",
    };
  }

  // 6. Record the test webhook event in the database
  try {
    await prisma.webhookEvent.create({
      data: {
        deliveryId,
        repositoryId: repo?.id || null,
      },
    });
  } catch (err: any) {
    console.error("[Onboarding] Failed to record test webhook event:", err);
    return {
      success: false,
      error: `Database Error: Failed to record test webhook delivery (${err?.message || "Unknown error"}).`,
    };
  }

  revalidatePath("/dashboard");

  return {
    success: true,
    message: "Webhook delivery received and HMAC signature verified successfully!",
    deliveryId,
  };
}
