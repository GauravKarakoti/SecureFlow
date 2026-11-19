"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { assertSlackWebhookUrl, sendSlackAlert } from "@/lib/integrations/slack";
import { assertTeamsWebhookUrl, sendTeamsAlert, buildTeamsAlert } from "@/lib/integrations/teams";
import { buildBlockedSlackAlert } from "@/lib/integrations/notification-dispatcher";
import {
  generateApiToken,
  isValidScope,
} from "@/lib/auth/api-token";
import { sanitizeAuditLogInput } from "@/lib/audit/minimization";

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

export async function createApiToken(
  input: CreateApiTokenInput,
): Promise<CreateApiTokenResult> {
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

export async function revokeApiToken(
  tokenId: string,
): Promise<RevokeApiTokenResult> {
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
