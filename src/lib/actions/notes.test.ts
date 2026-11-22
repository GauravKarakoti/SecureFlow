import { beforeEach, describe, expect, it, vi } from "vitest";

let session: { user: { id: string; roles?: string[] } } | null = {
  user: { id: "user-1", roles: ["USER"] },
};

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => session),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockAuditLogCreate = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  finding: { findUnique: vi.fn() },
  findingNote: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
  auditLog: { create: mockAuditLogCreate },
}));

vi.mock("@/lib/prisma", () => ({ default: prismaMock }));

import { getFindingNotes, addFindingNote, deleteFindingNote, MAX_NOTE_LENGTH } from "./notes";

describe("Finding Notes Server Actions (#1920)", () => {
  const mockRepo = { id: "repo-1", userId: "user-1", fullName: "org/repo" };
  const mockFinding = {
    id: "finding-1",
    scanResult: {
      pullRequest: {
        repository: mockRepo,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session = { user: { id: "user-1", roles: ["USER"] } };
    prismaMock.finding.findUnique.mockResolvedValue(mockFinding);
    mockAuditLogCreate.mockResolvedValue({ id: "audit-1" });
  });

  describe("getFindingNotes", () => {
    it("rejects unauthenticated users", async () => {
      session = null;
      await expect(getFindingNotes("finding-1")).rejects.toThrow("Unauthorized");
    });

    it("rejects users without repository access", async () => {
      session = { user: { id: "intruder-99", roles: ["USER"] } };
      await expect(getFindingNotes("finding-1")).rejects.toThrow("Forbidden");
    });

    it("allows administrators even if not repository owner", async () => {
      session = { user: { id: "admin-1", roles: ["ADMIN"] } };
      prismaMock.findingNote.findMany.mockResolvedValue([
        { id: "note-1", text: "Admin note", createdAt: new Date() },
      ]);

      const notes = await getFindingNotes("finding-1");
      expect(notes).toHaveLength(1);
      expect(prismaMock.findingNote.findMany).toHaveBeenCalledWith({
        where: { findingId: "finding-1" },
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
              codename: true,
              image: true,
            },
          },
        },
      });
    });

    it("returns notes for repository owner", async () => {
      const mockNotes = [
        { id: "n-1", text: "First note", createdAt: new Date() },
        { id: "n-2", text: "Second note", createdAt: new Date() },
      ];
      prismaMock.findingNote.findMany.mockResolvedValue(mockNotes);

      const notes = await getFindingNotes("finding-1");
      expect(notes).toEqual(mockNotes);
    });
  });

  describe("addFindingNote", () => {
    it("rejects unauthenticated users", async () => {
      session = null;
      await expect(addFindingNote("finding-1", "Hello")).rejects.toThrow("Unauthorized");
    });

    it("rejects empty or whitespace-only note", async () => {
      const res1 = await addFindingNote("finding-1", "");
      expect(res1).toEqual({ ok: false, error: "Note cannot be empty" });

      const res2 = await addFindingNote("finding-1", "   \n\t  ");
      expect(res2).toEqual({ ok: false, error: "Note cannot be empty" });
    });

    it("rejects notes exceeding MAX_NOTE_LENGTH", async () => {
      const longText = "a".repeat(MAX_NOTE_LENGTH + 1);
      const res = await addFindingNote("finding-1", longText);
      expect(res.ok).toBe(false);
      expect(res.error).toContain(`at most ${MAX_NOTE_LENGTH.toLocaleString()} characters`);
    });

    it("rejects user without access to repository", async () => {
      session = { user: { id: "stranger-1", roles: ["USER"] } };
      const res = await addFindingNote("finding-1", "Trying to comment");
      expect(res).toEqual({
        ok: false,
        error: "Forbidden: You do not have access to this repository",
      });
      expect(prismaMock.findingNote.create).not.toHaveBeenCalled();
    });

    it("creates note, records in audit log and revalidates paths", async () => {
      const createdNote = {
        id: "note-new",
        findingId: "finding-1",
        authorId: "user-1",
        text: "Verified false positive due to mock test fixture.",
        createdAt: new Date(),
        author: { id: "user-1", name: "Alice", email: "alice@example.com" },
      };
      prismaMock.findingNote.create.mockResolvedValue(createdNote);

      const res = await addFindingNote(
        "finding-1",
        "  Verified false positive due to mock test fixture.  ",
      );

      expect(res.ok).toBe(true);
      expect(res.note).toEqual(createdNote);

      // Verifies trimmed text was saved
      expect(prismaMock.findingNote.create).toHaveBeenCalledWith({
        data: {
          findingId: "finding-1",
          authorId: "user-1",
          text: "Verified false positive due to mock test fixture.",
        },
        include: {
          author: {
            select: {
              id: true,
              name: true,
              email: true,
              codename: true,
              image: true,
            },
          },
        },
      });

      // Verifies audit log record
      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          action: "FINDING_NOTE_CREATE",
          resource: "finding:finding-1",
          decision: "CREATED",
          metadata: {
            findingId: "finding-1",
            noteId: "note-new",
            authorId: "user-1",
            length: createdNote.text.length,
            repositoryId: "repo-1",
          },
        }),
      });
    });
  });

  describe("deleteFindingNote", () => {
    const existingNote = {
      id: "note-123",
      findingId: "finding-1",
      authorId: "user-1",
      text: "Some context",
      finding: mockFinding,
    };

    it("rejects unauthenticated user", async () => {
      session = null;
      await expect(deleteFindingNote("note-123")).rejects.toThrow("Unauthorized");
    });

    it("returns error if note does not exist", async () => {
      prismaMock.findingNote.findUnique.mockResolvedValue(null);
      const res = await deleteFindingNote("missing-note");
      expect(res).toEqual({ ok: false, error: "Note not found" });
    });

    it("returns forbidden if user has no repository access", async () => {
      session = { user: { id: "intruder", roles: ["USER"] } };
      prismaMock.findingNote.findUnique.mockResolvedValue(existingNote);

      const res = await deleteFindingNote("note-123");
      expect(res).toEqual({
        ok: false,
        error: "Forbidden: You do not have access to this repository",
      });
    });

    it("forbids non-author non-admin from deleting another user's note", async () => {
      // Bob is repository member/owner? Bob has repo access (repo.userId = bob), but Alice is author
      session = { user: { id: "user-bob", roles: ["USER"] } };
      const noteByAlice = {
        ...existingNote,
        authorId: "user-alice",
        finding: {
          scanResult: {
            pullRequest: {
              repository: { id: "repo-1", userId: "user-bob" },
            },
          },
        },
      };
      prismaMock.findingNote.findUnique.mockResolvedValue(noteByAlice);

      const res = await deleteFindingNote("note-123");
      expect(res).toEqual({
        ok: false,
        error: "Forbidden: Only the author or an administrator can delete this note",
      });
      expect(prismaMock.findingNote.delete).not.toHaveBeenCalled();
    });

    it("allows author to delete their own note", async () => {
      session = { user: { id: "user-1", roles: ["USER"] } };
      prismaMock.findingNote.findUnique.mockResolvedValue(existingNote);
      prismaMock.findingNote.delete.mockResolvedValue(existingNote);

      const res = await deleteFindingNote("note-123");
      expect(res).toEqual({ ok: true });
      expect(prismaMock.findingNote.delete).toHaveBeenCalledWith({
        where: { id: "note-123" },
      });

      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-1",
          action: "FINDING_NOTE_DELETE",
          resource: "finding:finding-1",
          decision: "DELETED",
          metadata: {
            findingId: "finding-1",
            noteId: "note-123",
            authorId: "user-1",
            deletedBy: "user-1",
            isAuthor: true,
            isAdmin: false,
            repositoryId: "repo-1",
          },
        }),
      });
    });

    it("allows admin to delete any note", async () => {
      session = { user: { id: "admin-1", roles: ["ADMIN"] } };
      const noteByAlice = {
        ...existingNote,
        authorId: "user-alice",
      };
      prismaMock.findingNote.findUnique.mockResolvedValue(noteByAlice);
      prismaMock.findingNote.delete.mockResolvedValue(noteByAlice);

      const res = await deleteFindingNote("note-123");
      expect(res).toEqual({ ok: true });
      expect(prismaMock.findingNote.delete).toHaveBeenCalledWith({
        where: { id: "note-123" },
      });

      expect(mockAuditLogCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "admin-1",
          action: "FINDING_NOTE_DELETE",
          resource: "finding:finding-1",
          decision: "DELETED",
          metadata: {
            findingId: "finding-1",
            noteId: "note-123",
            authorId: "user-alice",
            deletedBy: "admin-1",
            isAuthor: false,
            isAdmin: true,
            repositoryId: "repo-1",
          },
        }),
      });
    });
  });
});
