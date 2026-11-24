import { describe, it, expect, vi, beforeEach } from "vitest";

let mockSession: { user: { id: string; name?: string; email?: string } } | null = {
  user: { id: "user-alice", name: "Alice", email: "alice@example.com" },
};

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockUserFindUnique = vi.hoisted(() => vi.fn());
const mockUserFindFirst = vi.hoisted(() => vi.fn());
const mockUserUpdate = vi.hoisted(() => vi.fn());

const mockNotificationCreate = vi.hoisted(() => vi.fn());
const mockNotificationFindMany = vi.hoisted(() => vi.fn());
const mockNotificationFindUnique = vi.hoisted(() => vi.fn());
const mockNotificationFindFirst = vi.hoisted(() => vi.fn());
const mockNotificationCount = vi.hoisted(() => vi.fn());
const mockNotificationUpdate = vi.hoisted(() => vi.fn());
const mockNotificationUpdateMany = vi.hoisted(() => vi.fn());
const mockNotificationDelete = vi.hoisted(() => vi.fn());

const mockFindingTriageFindMany = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({
  default: {
    user: {
      findUnique: mockUserFindUnique,
      findFirst: mockUserFindFirst,
      update: mockUserUpdate,
    },
    notification: {
      create: mockNotificationCreate,
      findMany: mockNotificationFindMany,
      findUnique: mockNotificationFindUnique,
      findFirst: mockNotificationFindFirst,
      count: mockNotificationCount,
      update: mockNotificationUpdate,
      updateMany: mockNotificationUpdateMany,
      delete: mockNotificationDelete,
    },
    findingTriage: {
      findMany: mockFindingTriageFindMany,
    },
  },
}));

const mockCheckUserRepoAccess = vi.hoisted(() => vi.fn());
vi.mock("@/lib/actions/assignee", () => ({
  checkUserRepoAccess: mockCheckUserRepoAccess,
}));

import {
  createNotification,
  extractMentions,
  notifyMentionedUsers,
  notifyFindingAssignment,
  notifyExpiringDismissals,
  getNotifications,
  getUnreadNotificationCount,
  getLatestNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  getNotificationPreferences,
  updateNotificationPreferences,
  sanitizeNotificationMessage,
} from "./notifications";

describe("Notifications System (#1979)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = { user: { id: "user-alice", name: "Alice", email: "alice@example.com" } };

    mockUserFindUnique.mockResolvedValue({
      id: "user-alice",
      notifyOnAssignment: true,
      notifyOnMention: true,
      notifyOnDismissalExpiry: true,
    });

    mockNotificationCreate.mockImplementation(async (args: any) => ({
      id: "notif-123",
      createdAt: new Date(),
      readAt: null,
      ...args.data,
    }));
  });

  describe("Message Sanitization (No Code Snippets or Secret Values)", () => {
    it("strips code blocks from notification text", () => {
      const raw = "Look at this issue: ```const secret = 123;``` please review.";
      const sanitized = sanitizeNotificationMessage(raw);
      expect(sanitized).not.toContain("const secret = 123;");
      expect(sanitized).toContain("[code snippet omitted]");
    });

    it("strips inline code snippets", () => {
      const raw = "Found `SELECT * FROM users` in auth.ts";
      const sanitized = sanitizeNotificationMessage(raw);
      expect(sanitized).not.toContain("SELECT * FROM users");
      expect(sanitized).toContain("[code omitted]");
    });

    it("redacts potential secret patterns (GitHub tokens, AWS keys, Bearer headers)", () => {
      const raw =
        "Secret ghp_123456789012345678901234567890123456 with AKIAIOSFODNN7EXAMPLE and Bearer mytoken123";
      const sanitized = sanitizeNotificationMessage(raw);
      expect(sanitized).not.toContain("ghp_123456789012345678901234567890123456");
      expect(sanitized).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(sanitized).not.toContain("mytoken123");
      expect(sanitized).toContain("[REDACTED_SECRET]");
      expect(sanitized).toContain("[REDACTED_AWS_KEY]");
      expect(sanitized).toContain("Bearer [REDACTED]");
    });
  });

  describe("extractMentions helper", () => {
    it("extracts unique lowercased usernames from note text", () => {
      const text = "Hey @Bob, could you and @Alice check this? cc @bob again";
      const mentions = extractMentions(text);
      expect(mentions).toEqual(["bob", "alice"]);
    });

    it("returns empty array when text has no mentions", () => {
      expect(extractMentions("A note without any mentions.")).toEqual([]);
      expect(extractMentions("")).toEqual([]);
    });
  });

  describe("createNotification & Opt-Out Preferences", () => {
    it("creates an unread notification when recipient is opted in", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        id: "user-bob",
        notifyOnAssignment: true,
        notifyOnMention: true,
        notifyOnDismissalExpiry: true,
      });

      const notif = await createNotification({
        userId: "user-bob",
        type: "FINDING_ASSIGNED",
        title: "Finding assigned",
        message: "You were assigned a finding.",
        link: "/dashboard/findings/f-1",
      });

      expect(notif).not.toBeNull();
      expect(mockNotificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-bob",
          type: "FINDING_ASSIGNED",
          title: "Finding assigned",
          readAt: null,
        }),
      });
    });

    it("does not create notification if user opted out of assignment notifications", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        id: "user-bob",
        notifyOnAssignment: false,
        notifyOnMention: true,
        notifyOnDismissalExpiry: true,
      });

      const notif = await createNotification({
        userId: "user-bob",
        type: "FINDING_ASSIGNED",
        title: "Finding assigned",
        message: "You were assigned a finding.",
      });

      expect(notif).toBeNull();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it("does not create notification if user opted out of mention notifications", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        id: "user-bob",
        notifyOnAssignment: true,
        notifyOnMention: false,
        notifyOnDismissalExpiry: true,
      });

      const notif = await createNotification({
        userId: "user-bob",
        type: "MENTION",
        title: "Mentioned",
        message: "Someone mentioned you.",
      });

      expect(notif).toBeNull();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it("does not create notification if user opted out of dismissal expiry notifications", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        id: "user-bob",
        notifyOnAssignment: true,
        notifyOnMention: true,
        notifyOnDismissalExpiry: false,
      });

      const notif = await createNotification({
        userId: "user-bob",
        type: "DISMISSAL_EXPIRING",
        title: "Expiring",
        message: "Dismissal expiring.",
      });

      expect(notif).toBeNull();
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });
  });

  describe("Reviewer Note Mentions Access Control", () => {
    it("creates a notification when a repository member is mentioned", async () => {
      mockUserFindFirst.mockResolvedValueOnce({
        id: "user-member",
        name: "Member Bob",
        codename: "bob",
        notifyOnMention: true,
      });
      mockCheckUserRepoAccess.mockResolvedValueOnce(true);

      const count = await notifyMentionedUsers({
        text: "Please check this @bob",
        findingId: "finding-1",
        repositoryId: "repo-1",
        authorId: "user-alice",
        authorName: "Alice",
        repoFullName: "org/repo",
      });

      expect(count).toBe(1);
      expect(mockNotificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-member",
          type: "MENTION",
          title: "Mentioned in finding note",
          link: "/dashboard/findings/finding-1",
        }),
      });
    });

    it("creates NOTHING when the mentioned user does NOT have repository access", async () => {
      mockUserFindFirst.mockResolvedValueOnce({
        id: "user-outsider",
        name: "Outsider Mallory",
        codename: "mallory",
        notifyOnMention: true,
      });
      // Repository access check returns FALSE
      mockCheckUserRepoAccess.mockResolvedValueOnce(false);

      const count = await notifyMentionedUsers({
        text: "FYI @mallory look at this",
        findingId: "finding-1",
        repositoryId: "repo-1",
        authorId: "user-alice",
        authorName: "Alice",
        repoFullName: "org/repo",
      });

      expect(count).toBe(0);
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });

    it("does not notify the author if they mention themselves", async () => {
      mockUserFindFirst.mockResolvedValueOnce({
        id: "user-alice",
        name: "Alice",
        codename: "alice",
        notifyOnMention: true,
      });

      const count = await notifyMentionedUsers({
        text: "Note to self @alice check tomorrow",
        findingId: "finding-1",
        repositoryId: "repo-1",
        authorId: "user-alice",
      });

      expect(count).toBe(0);
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });
  });

  describe("Finding Assignment Alerts", () => {
    it("creates exactly one unread notification when a finding is assigned", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        id: "user-bob",
        notifyOnAssignment: true,
      });

      const notif = await notifyFindingAssignment({
        assigneeId: "user-bob",
        actorId: "user-alice",
        actorName: "Alice",
        repositoryId: "repo-1",
        repoFullName: "org/repo",
        fingerprint: "fp-123",
        findingId: "finding-77",
      });

      expect(notif).not.toBeNull();
      expect(mockNotificationCreate).toHaveBeenCalledOnce();
      expect(mockNotificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-bob",
          type: "FINDING_ASSIGNED",
          title: "Finding assigned to you",
          link: "/dashboard/findings/finding-77",
        }),
      });
    });
  });

  describe("Expiring Dismissals Alerts", () => {
    it("creates notification for dismissals expiring soon", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      const expiresSoon = new Date("2026-06-07T00:00:00.000Z");

      mockFindingTriageFindMany.mockResolvedValueOnce([
        {
          id: "triage-1",
          status: "FALSE_POSITIVE",
          expiresAt: expiresSoon,
          dismissedById: "user-alice",
          repository: { id: "repo-1", fullName: "org/repo" },
        },
      ]);
      mockNotificationFindFirst.mockResolvedValueOnce(null); // No existing unread notification

      const count = await notifyExpiringDismissals({
        userId: "user-alice",
        windowDays: 14,
        now,
      });

      expect(count).toBe(1);
      expect(mockNotificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-alice",
          type: "DISMISSAL_EXPIRING",
          title: "Finding dismissal expiring soon",
        }),
      });
    });

    it("does not create duplicate notification if unread expiry alert already exists", async () => {
      const now = new Date("2026-06-01T00:00:00.000Z");
      mockFindingTriageFindMany.mockResolvedValueOnce([
        {
          id: "triage-1",
          status: "FALSE_POSITIVE",
          expiresAt: new Date("2026-06-07T00:00:00.000Z"),
          dismissedById: "user-alice",
          repository: { id: "repo-1", fullName: "org/repo" },
        },
      ]);
      mockNotificationFindFirst.mockResolvedValueOnce({ id: "existing-notif" });

      const count = await notifyExpiringDismissals({
        userId: "user-alice",
        now,
      });

      expect(count).toBe(0);
      expect(mockNotificationCreate).not.toHaveBeenCalled();
    });
  });

  describe("Reading and Permissions (Own Notifications Only)", () => {
    it("fetches only notifications belonging to the session user", async () => {
      mockNotificationFindMany.mockResolvedValueOnce([
        { id: "notif-1", userId: "user-alice", title: "Note 1" },
      ]);
      mockNotificationCount.mockResolvedValueOnce(1); // total
      mockNotificationCount.mockResolvedValueOnce(1); // unread

      const res = await getNotifications();

      expect(res.notifications).toHaveLength(1);
      expect(mockNotificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "user-alice" }),
        }),
      );
    });

    it("allows user to mark their own notification as read", async () => {
      mockNotificationFindUnique.mockResolvedValueOnce({
        id: "notif-own",
        userId: "user-alice",
      });

      const res = await markNotificationAsRead("notif-own");
      expect(res.ok).toBe(true);
      expect(mockNotificationUpdate).toHaveBeenCalledWith({
        where: { id: "notif-own" },
        data: { readAt: expect.any(Date) },
      });
    });

    it("FORBIDS user from marking another user's notification as read", async () => {
      mockNotificationFindUnique.mockResolvedValueOnce({
        id: "notif-other",
        userId: "user-bob", // Belongs to Bob, session is Alice
      });

      const res = await markNotificationAsRead("notif-other");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Forbidden");
      expect(mockNotificationUpdate).not.toHaveBeenCalled();
    });

    it("FORBIDS user from deleting another user's notification", async () => {
      mockNotificationFindUnique.mockResolvedValueOnce({
        id: "notif-other",
        userId: "user-bob",
      });

      const res = await deleteNotification("notif-other");
      expect(res.ok).toBe(false);
      expect(res.error).toContain("Forbidden");
      expect(mockNotificationDelete).not.toHaveBeenCalled();
    });

    it("marks all unread notifications as read for current user", async () => {
      mockNotificationUpdateMany.mockResolvedValueOnce({ count: 3 });

      const res = await markAllNotificationsAsRead();
      expect(res.ok).toBe(true);
      expect(res.count).toBe(3);
      expect(mockNotificationUpdateMany).toHaveBeenCalledWith({
        where: {
          userId: "user-alice",
          readAt: null,
        },
        data: { readAt: expect.any(Date) },
      });
    });
  });

  describe("Unread Count & Latest Notifications", () => {
    it("returns unread count accurately", async () => {
      mockNotificationCount.mockResolvedValueOnce(4);
      const count = await getUnreadNotificationCount();
      expect(count).toBe(4);
      expect(mockNotificationCount).toHaveBeenCalledWith({
        where: { userId: "user-alice", readAt: null },
      });
    });

    it("returns latest notifications for dropdown", async () => {
      mockNotificationFindMany.mockResolvedValueOnce([{ id: "n1", title: "Latest" }]);
      mockNotificationCount.mockResolvedValueOnce(1);

      const data = await getLatestNotifications(5);
      expect(data.notifications).toHaveLength(1);
      expect(data.unreadCount).toBe(1);
      expect(mockNotificationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 5,
          where: { userId: "user-alice" },
        }),
      );
    });
  });

  describe("Preferences Retrieval and Updates", () => {
    it("retrieves notification preferences for session user", async () => {
      mockUserFindUnique.mockResolvedValueOnce({
        notifyOnAssignment: true,
        notifyOnMention: false,
        notifyOnDismissalExpiry: true,
      });

      const prefs = await getNotificationPreferences();
      expect(prefs).toEqual({
        notifyOnAssignment: true,
        notifyOnMention: false,
        notifyOnDismissalExpiry: true,
      });
    });

    it("updates notification preferences", async () => {
      mockUserUpdate.mockResolvedValueOnce({
        notifyOnAssignment: false,
        notifyOnMention: false,
        notifyOnDismissalExpiry: true,
      });

      const res = await updateNotificationPreferences({
        notifyOnAssignment: false,
        notifyOnMention: false,
      });

      expect(res.ok).toBe(true);
      expect(mockUserUpdate).toHaveBeenCalledWith({
        where: { id: "user-alice" },
        data: {
          notifyOnAssignment: false,
          notifyOnMention: false,
        },
        select: expect.any(Object),
      });
    });
  });
});
