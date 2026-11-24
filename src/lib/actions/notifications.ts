"use server";

import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { checkUserRepoAccess } from "@/lib/actions/assignee";
import { isExpiringSoon } from "@/lib/triage/expiry";
import { SUPPRESSED_STATUSES } from "@/lib/triage/statuses";

export type NotificationType = "FINDING_ASSIGNED" | "MENTION" | "DISMISSAL_EXPIRING";

export interface NotificationDto {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link: string | null;
  findingId: string | null;
  scanId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationPreferencesDto {
  notifyOnAssignment: boolean;
  notifyOnMention: boolean;
  notifyOnDismissalExpiry: boolean;
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
  findingId?: string | null;
  scanId?: string | null;
}

/**
 * Sanitizes notification message to ensure no code snippets, diffs, or secrets
 * are leaked in the notification text.
 */
export function sanitizeNotificationMessage(text: string): string {
  if (!text) return "";
  // Strip code blocks: ```code```
  let sanitized = text.replace(/```[\s\S]*?```/g, "[code snippet omitted]");
  // Strip inline code: `code`
  sanitized = sanitized.replace(/`[^`]+`/g, "[code omitted]");
  // Redact potential secret-like tokens
  sanitized = sanitized.replace(
    /(ghp_[A-Za-z0-9_]{36}|github_pat_[A-Za-z0-9_]{82})/g,
    "[REDACTED_SECRET]",
  );
  sanitized = sanitized.replace(/(AKIA[0-9A-Z]{16})/g, "[REDACTED_AWS_KEY]");
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]");
  return sanitized.trim();
}

/**
 * Create a single in-app notification.
 * Respects recipient per-type opt-out preferences and sanitizes text.
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<NotificationDto | null> {
  const { userId, type, title, message, link, findingId, scanId } = input;
  if (!userId || !type || !title) return null;

  // Check recipient opt-out preferences
  const recipient = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      notifyOnAssignment: true,
      notifyOnMention: true,
      notifyOnDismissalExpiry: true,
    },
  });

  if (!recipient) return null;

  if (type === "FINDING_ASSIGNED" && recipient.notifyOnAssignment === false) {
    return null;
  }
  if (type === "MENTION" && recipient.notifyOnMention === false) {
    return null;
  }
  if (type === "DISMISSAL_EXPIRING" && recipient.notifyOnDismissalExpiry === false) {
    return null;
  }

  const safeTitle = sanitizeNotificationMessage(title);
  const safeMessage = sanitizeNotificationMessage(message);

  const notification = await prisma.notification.create({
    data: {
      userId,
      type: type as any,
      title: safeTitle,
      message: safeMessage,
      link: link || null,
      findingId: findingId || null,
      scanId: scanId || null,
      readAt: null,
    },
  });

  return notification as NotificationDto;
}

/**
 * Parses @mentions in note text and returns a list of unique mentioned user identifiers.
 * e.g., "@alice check this with @bob" -> ["alice", "bob"]
 */
export function extractMentions(text: string): string[] {
  if (!text) return [];
  const regex = /@([a-zA-Z0-9_\-\.]+)/g;
  const matches = Array.from(text.matchAll(regex)).map((m) => m[1]);
  return Array.from(new Set(matches.map((m) => m.toLowerCase())));
}

/**
 * Notifies repository members who were @mentioned in a finding note.
 * Only users who have repository access will receive a notification.
 */
export async function notifyMentionedUsers(params: {
  text: string;
  findingId: string;
  repositoryId: string;
  authorId: string;
  authorName?: string | null;
  repoFullName?: string | null;
}): Promise<number> {
  const { text, findingId, repositoryId, authorId, authorName, repoFullName } = params;
  const mentions = extractMentions(text);
  if (mentions.length === 0) return 0;

  let notifiedCount = 0;

  for (const mention of mentions) {
    // Find candidate user by codename, name, or email
    const candidate = await prisma.user.findFirst({
      where: {
        OR: [
          { codename: { equals: mention, mode: "insensitive" } },
          { name: { equals: mention, mode: "insensitive" } },
          { email: { equals: mention, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        name: true,
        codename: true,
        notifyOnMention: true,
      },
    });

    if (!candidate) continue;

    // Do not notify author if they mention themselves
    if (candidate.id === authorId) continue;

    // Verify target user has repository access
    const hasAccess = await checkUserRepoAccess(candidate.id, repositoryId);
    if (!hasAccess) {
      continue;
    }

    const senderDisplay = authorName || "A team member";
    const repoDisplay = repoFullName || "the repository";

    const created = await createNotification({
      userId: candidate.id,
      type: "MENTION",
      title: "Mentioned in finding note",
      message: `${senderDisplay} mentioned you in a note on a finding in ${repoDisplay}.`,
      link: `/dashboard/findings/${findingId}`,
      findingId,
    });

    if (created) {
      notifiedCount++;
    }
  }

  return notifiedCount;
}

/**
 * Trigger notification when a finding is assigned to a user.
 */
export async function notifyFindingAssignment(params: {
  assigneeId: string;
  actorId: string;
  actorName?: string | null;
  repositoryId: string;
  repoFullName?: string | null;
  fingerprint: string;
  findingId?: string | null;
}): Promise<NotificationDto | null> {
  const { assigneeId, actorName, repoFullName, findingId } = params;
  if (!assigneeId) return null;

  const repoDisplay = repoFullName || "the repository";
  const actorDisplay = actorName || "A team member";

  return await createNotification({
    userId: assigneeId,
    type: "FINDING_ASSIGNED",
    title: "Finding assigned to you",
    message: `${actorDisplay} assigned a security finding to you in ${repoDisplay}.`,
    link: findingId ? `/dashboard/findings/${findingId}` : "/dashboard/findings",
    findingId: findingId || null,
  });
}

/**
 * Check for owned dismissals that are expiring soon and create notifications for their owners.
 */
export async function notifyExpiringDismissals(
  params: {
    userId?: string;
    windowDays?: number;
    now?: Date;
  } = {},
): Promise<number> {
  const now = params.now ?? new Date();
  const windowDays = params.windowDays ?? 14;

  const cutoffDate = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const expiringTriages = await prisma.findingTriage.findMany({
    where: {
      status: { in: [...SUPPRESSED_STATUSES] },
      expiresAt: {
        gt: now,
        lte: cutoffDate,
      },
      dismissedById: params.userId ? params.userId : { not: null },
    },
    include: {
      repository: {
        select: { id: true, fullName: true },
      },
    },
  });

  let createdCount = 0;

  for (const triage of expiringTriages) {
    if (!triage.dismissedById || !triage.expiresAt) continue;

    // Check if an unread notification for this dismissal already exists
    const existing = await prisma.notification.findFirst({
      where: {
        userId: triage.dismissedById,
        type: "DISMISSAL_EXPIRING",
        readAt: null,
        message: { contains: triage.repository.fullName },
      },
    });

    if (existing) continue;

    const dateStr = triage.expiresAt.toISOString().slice(0, 10);
    const created = await createNotification({
      userId: triage.dismissedById,
      type: "DISMISSAL_EXPIRING",
      title: "Finding dismissal expiring soon",
      message: `A dismissal you created in ${triage.repository.fullName} will expire on ${dateStr}.`,
      link: "/dashboard/findings?expiring=true",
    });

    if (created) {
      createdCount++;
    }
  }

  return createdCount;
}

/**
 * Fetch paginated notifications for the current authenticated user.
 */
export async function getNotifications(
  params: {
    page?: number;
    limit?: number;
    unreadOnly?: boolean;
  } = {},
): Promise<{
  notifications: NotificationDto[];
  total: number;
  unreadCount: number;
  page: number;
  pageCount: number;
}> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const userId = session.user.id;
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(50, Math.max(1, params.limit ?? 20));
  const skip = (page - 1) * limit;

  const whereClause: any = { userId };
  if (params.unreadOnly) {
    whereClause.readAt = null;
  }

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: whereClause }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return {
    notifications: notifications as NotificationDto[],
    total,
    unreadCount,
    page,
    pageCount: Math.ceil(total / limit) || 1,
  };
}

/**
 * Get count of unread notifications for current user.
 */
export async function getUnreadNotificationCount(): Promise<number> {
  const session = await auth();
  if (!session?.user?.id) {
    return 0;
  }

  return await prisma.notification.count({
    where: {
      userId: session.user.id,
      readAt: null,
    },
  });
}

/**
 * Get latest notifications for the header dropdown.
 */
export async function getLatestNotifications(limit = 5): Promise<{
  notifications: NotificationDto[];
  unreadCount: number;
}> {
  const session = await auth();
  if (!session?.user?.id) {
    return { notifications: [], unreadCount: 0 };
  }

  const userId = session.user.id;
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  return {
    notifications: notifications as NotificationDto[],
    unreadCount,
  };
}

/**
 * Mark a single notification as read.
 * Users can only mark their own notifications.
 */
export async function markNotificationAsRead(id: string): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const notif = await prisma.notification.findUnique({
    where: { id },
  });

  if (!notif) {
    return { ok: false, error: "Notification not found" };
  }

  if (notif.userId !== session.user.id) {
    return { ok: false, error: "Forbidden: You cannot modify this notification" };
  }

  await prisma.notification.update({
    where: { id },
    data: { readAt: new Date() },
  });

  revalidatePath("/dashboard/notifications");
  return { ok: true };
}

/**
 * Mark all unread notifications as read for current user.
 */
export async function markAllNotificationsAsRead(): Promise<{ ok: boolean; count: number }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const result = await prisma.notification.updateMany({
    where: {
      userId: session.user.id,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });

  revalidatePath("/dashboard/notifications");
  return { ok: true, count: result.count };
}

/**
 * Delete a notification.
 * Users can only delete their own notifications.
 */
export async function deleteNotification(id: string): Promise<{ ok: boolean; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const notif = await prisma.notification.findUnique({
    where: { id },
  });

  if (!notif) {
    return { ok: false, error: "Notification not found" };
  }

  if (notif.userId !== session.user.id) {
    return { ok: false, error: "Forbidden: You cannot delete this notification" };
  }

  await prisma.notification.delete({
    where: { id },
  });

  revalidatePath("/dashboard/notifications");
  return { ok: true };
}

/**
 * Get notification preferences for the authenticated user.
 */
export async function getNotificationPreferences(): Promise<NotificationPreferencesDto> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      notifyOnAssignment: true,
      notifyOnMention: true,
      notifyOnDismissalExpiry: true,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      notifyOnAssignment: true,
      notifyOnMention: true,
      notifyOnDismissalExpiry: true,
    },
  });

  return {
    notifyOnAssignment: user?.notifyOnAssignment ?? true,
    notifyOnMention: user?.notifyOnMention ?? true,
    notifyOnDismissalExpiry: user?.notifyOnDismissalExpiry ?? true,
  };
}

/**
 * Update notification preferences for the authenticated user.
 */
export async function updateNotificationPreferences(
  input: Partial<NotificationPreferencesDto>,
): Promise<{ ok: boolean; preferences?: NotificationPreferencesDto; error?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Unauthorized");
  }

  const updated = await prisma.user.update({
    where: { id: session.user.id },
    data: {
      ...(typeof input.notifyOnAssignment === "boolean" && {
        notifyOnAssignment: input.notifyOnAssignment,
      }),
      ...(typeof input.notifyOnMention === "boolean" && {
        notifyOnMention: input.notifyOnMention,
      }),
      ...(typeof input.notifyOnDismissalExpiry === "boolean" && {
        notifyOnDismissalExpiry: input.notifyOnDismissalExpiry,
      }),
    },
    select: {
      notifyOnAssignment: true,
      notifyOnMention: true,
      notifyOnDismissalExpiry: true,
    },
  });

  revalidatePath("/dashboard/settings");
  return { ok: true, preferences: updated };
}
