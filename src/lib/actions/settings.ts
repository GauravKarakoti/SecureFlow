"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { assertSlackWebhookUrl, sendSlackAlert } from "@/lib/integrations/slack";
import { assertTeamsWebhookUrl, sendTeamsAlert, buildTeamsAlert } from "@/lib/integrations/teams";
import { buildBlockedSlackAlert } from "@/lib/integrations/notification-dispatcher";
import { generateApiToken, isValidScope } from "@/lib/auth/api-token";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";
import { validateOutboundWebhookUrl } from "@/lib/webhooks/outbound-security";
import { generateOutboundWebhookSecret } from "@/lib/webhooks/outbound-signature";
import {
  deliverOutboundWebhook,
  isValidOutboundEvent,
  OUTBOUND_EVENT_TYPES,
  type OutboundEventType,
} from "@/lib/webhooks/outbound-dispatcher";

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
  codeScanningEnabled: boolean;
  codeScanningWarning?: string | null;
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
      codeScanningEnabled: true,
      codeScanningWarning: true,
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
      codeScanningEnabled: boolean;
      codeScanningWarning?: string | null;
      pullRequests: Array<{ status: string }>;
    }>
  ).map((repo) => ({
    id: repo.id,
    fullName: repo.fullName,
    owner: repo.owner,
    publicBadgeEnabled: repo.publicBadgeEnabled,
    codeScanningEnabled: repo.codeScanningEnabled,
    codeScanningWarning: repo.codeScanningWarning ?? null,
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

export async function updateRepositoryCodeScanning(
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
    data: {
      codeScanningEnabled: Boolean(enabled),
      ...(enabled ? {} : { codeScanningWarning: null }),
    },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

export async function getWeeklyDigestPreference(): Promise<boolean> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return true;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { weeklyDigestEnabled: true },
  });

  return user?.weeklyDigestEnabled ?? true;
}

export async function updateWeeklyDigestPreference(
  enabled: boolean,
): Promise<{ success: boolean; enabled: boolean }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { weeklyDigestEnabled: Boolean(enabled) },
    select: { weeklyDigestEnabled: true },
  });

  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard/digest");
  return { success: true, enabled: updated.weeklyDigestEnabled };
}

// ─── Personal API Tokens (#1867) ─────────────────────────────────────────────

export interface ApiTokenItem {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: string[];
  expiresInDays?: number | null;
  customExpiresAt?: string | null;
}

export interface CreateApiTokenResult {
  success: boolean;
  token?: string;
  tokenItem?: ApiTokenItem;
  error?: string;
}

export interface RevokeApiTokenResult {
  success: boolean;
  error?: string;
}

export async function getApiTokens(): Promise<ApiTokenItem[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const tokens = await prisma.apiToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      lastUsedIp: true,
      createdAt: true,
    },
  });

  return (
    tokens as Array<{
      id: string;
      name: string;
      tokenPrefix: string;
      scopes: string[];
      expiresAt: Date | null;
      revokedAt: Date | null;
      lastUsedAt: Date | null;
      lastUsedIp: string | null;
      createdAt: Date;
    }>
  ).map((t) => ({
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    scopes: t.scopes,
    expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
    revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    lastUsedIp: t.lastUsedIp,
    createdAt: t.createdAt.toISOString(),
  }));
}

export async function createApiToken(input: CreateApiTokenInput): Promise<CreateApiTokenResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const name = input?.name?.trim();
  if (!name || name.length < 1 || name.length > 100) {
    return {
      success: false,
      error: "Token name must be between 1 and 100 characters.",
    };
  }

  const rawScopes = Array.isArray(input?.scopes) ? input.scopes : [];
  const validScopes = rawScopes.filter((s) => isValidScope(s));
  if (validScopes.length === 0) {
    return {
      success: false,
      error: "At least one valid scope must be selected.",
    };
  }

  let expiresAt: Date | null = null;
  if (typeof input.expiresInDays === "number" && input.expiresInDays > 0) {
    expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
  } else if (input.customExpiresAt) {
    const customDate = new Date(input.customExpiresAt);
    if (isNaN(customDate.getTime()) || customDate.getTime() <= Date.now()) {
      return {
        success: false,
        error: "Custom expiry date must be a valid future date.",
      };
    }
    expiresAt = customDate;
  } else {
    // Default to 30 days
    expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }

  const { token, tokenPrefix, tokenHash } = generateApiToken();

  const created = await prisma.apiToken.create({
    data: {
      userId,
      name,
      tokenHash,
      tokenPrefix,
      scopes: validScopes,
      expiresAt,
    },
  });

  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "API_TOKEN_CREATE",
        resource: `api_token:${created.id}`,
        decision: "ALLOW",
        metadata: {
          tokenId: created.id,
          tokenName: created.name,
          tokenPrefix: created.tokenPrefix,
          scopes: created.scopes,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
      }),
    });
  } catch (err) {
    console.error("Failed to write audit log for token creation:", err);
  }

  revalidatePath("/dashboard/settings");

  return {
    success: true,
    token,
    tokenItem: {
      id: created.id,
      name: created.name,
      tokenPrefix: created.tokenPrefix,
      scopes: created.scopes,
      expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
      revokedAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      createdAt: created.createdAt.toISOString(),
    },
  };
}

export async function revokeApiToken(tokenId: string): Promise<RevokeApiTokenResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const token = await prisma.apiToken.findFirst({
    where: { id: tokenId, userId },
  });

  if (!token) {
    return {
      success: false,
      error: "API token not found or unauthorized.",
    };
  }

  if (token.revokedAt !== null) {
    return { success: true };
  }

  await prisma.apiToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });

  try {
    await prisma.auditLog.create({
      data: sanitizeAuditLogInput({
        userId,
        action: "API_TOKEN_REVOKE",
        resource: `api_token:${token.id}`,
        decision: "ALLOW",
        metadata: {
          tokenId: token.id,
          tokenName: token.name,
          tokenPrefix: token.tokenPrefix,
        },
      }),
    });
  } catch (err) {
    console.error("Failed to write audit log for token revocation:", err);
  }

  revalidatePath("/dashboard/settings");

  return { success: true };
}

// ─── Outbound Webhooks (#1866) ───────────────────────────────────────────────

export interface OutboundWebhookView {
  id: string;
  url: string;
  events: string[];
  description?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  latestDelivery?: {
    id: string;
    event: string;
    statusCode?: number | null;
    error?: string | null;
    attempts: number;
    deliveredAt?: Date | null;
    createdAt: Date;
  } | null;
}

export interface OutboundWebhookDeliveryView {
  id: string;
  webhookId: string;
  eventId: string;
  event: string;
  statusCode?: number | null;
  error?: string | null;
  attempts: number;
  deliveredAt?: Date | null;
  createdAt: Date;
}

/**
 * Fetch all outbound webhooks configured by the authenticated user with recent delivery summaries.
 */
export async function getOutboundWebhooks(): Promise<OutboundWebhookView[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const webhooks = await prisma.outboundWebhook.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  return webhooks.map((w: any) => ({
    id: w.id,
    url: w.url,
    events: w.events,
    description: w.description,
    enabled: w.enabled,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    latestDelivery: w.deliveries[0]
      ? {
          id: w.deliveries[0].id,
          event: w.deliveries[0].event,
          statusCode: w.deliveries[0].statusCode,
          error: w.deliveries[0].error,
          attempts: w.deliveries[0].attempts,
          deliveredAt: w.deliveries[0].deliveredAt,
          createdAt: w.deliveries[0].createdAt,
        }
      : null,
  }));
}

/**
 * Register a new outbound webhook endpoint with SSRF validation and cryptographic secret generation.
 * Returns the plain secret once upon creation.
 */
export async function createOutboundWebhook(input: {
  url: string;
  events: string[];
  description?: string;
}): Promise<{
  success: boolean;
  error?: string;
  webhook?: {
    id: string;
    url: string;
    events: string[];
    description?: string | null;
    secret: string;
  };
}> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  // 1. Events validation
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { success: false, error: "Please select at least one event." };
  }

  const validEvents = input.events.filter(isValidOutboundEvent);
  if (validEvents.length === 0) {
    return {
      success: false,
      error: `Invalid events selected. Allowed events: ${OUTBOUND_EVENT_TYPES.join(", ")}`,
    };
  }

  // 2. SSRF & URL validation
  const validation = await validateOutboundWebhookUrl(input.url);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }

  // 3. Generate per-endpoint secret
  const secret = generateOutboundWebhookSecret();

  const created = await prisma.outboundWebhook.create({
    data: {
      userId,
      url: validation.url!.toString(),
      secret,
      events: validEvents,
      description: input.description?.trim() || null,
      enabled: true,
    },
  });

  revalidatePath("/dashboard/settings");

  return {
    success: true,
    webhook: {
      id: created.id,
      url: created.url,
      events: created.events,
      description: created.description,
      secret,
    },
  };
}

/**
 * Delete an outbound webhook endpoint.
 */
export async function deleteOutboundWebhook(
  webhookId: string,
): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const webhook = await prisma.outboundWebhook.findFirst({
    where: { id: webhookId, userId },
  });

  if (!webhook) {
    return { success: false, error: "Webhook not found or unauthorized." };
  }

  await prisma.outboundWebhook.delete({
    where: { id: webhookId },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

/**
 * Toggle an outbound webhook endpoint enabled status.
 */
export async function toggleOutboundWebhook(
  webhookId: string,
  enabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const webhook = await prisma.outboundWebhook.findFirst({
    where: { id: webhookId, userId },
  });

  if (!webhook) {
    return { success: false, error: "Webhook not found or unauthorized." };
  }

  await prisma.outboundWebhook.update({
    where: { id: webhookId },
    data: { enabled: Boolean(enabled) },
  });

  revalidatePath("/dashboard/settings");
  return { success: true };
}

/**
 * Retrieve delivery logs for a given webhook endpoint.
 */
export async function getOutboundWebhookDeliveries(
  webhookId: string,
  limit: number = 20,
): Promise<OutboundWebhookDeliveryView[]> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return [];

  const webhook = await prisma.outboundWebhook.findFirst({
    where: { id: webhookId, userId },
  });

  if (!webhook) return [];

  const deliveries = await prisma.outboundWebhookDelivery.findMany({
    where: { webhookId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return deliveries.map((d: any) => ({
    id: d.id,
    webhookId: d.webhookId,
    eventId: d.eventId,
    event: d.event,
    statusCode: d.statusCode,
    error: d.error,
    attempts: d.attempts,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
  }));
}

/**
 * Trigger a test delivery (ping) to verify endpoint connectivity.
 */
export async function testOutboundWebhook(webhookId: string): Promise<{
  success: boolean;
  statusCode?: number | null;
  error?: string | null;
  attempts: number;
}> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Unauthorized");
  }

  const webhook = await prisma.outboundWebhook.findFirst({
    where: { id: webhookId, userId },
  });

  if (!webhook) {
    return { success: false, error: "Webhook not found.", attempts: 0 };
  }

  const testEnvelope = {
    id: `evt_test_${crypto.randomUUID()}`,
    event: (webhook.events[0] || "scan.completed") as OutboundEventType,
    timestamp: new Date().toISOString(),
    data: {
      test: true,
      repository: "secureflow/test-ping",
      prNumber: 1,
      commitSha: "0000000000000000000000000000000000000000",
      decision: "PASS",
      totalFindings: 0,
      severityCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      findings: [],
    },
  };

  const outcome = await deliverOutboundWebhook(webhook, testEnvelope, {
    maxAttempts: 2,
    initialBackoffMs: 200,
  });

  revalidatePath("/dashboard/settings");
  return outcome;
}
