import { describe, it, expect, vi, beforeEach } from "vitest";
import { setFindingStatus, setFindingStatuses, type TriageStatus } from "@/lib/actions/triage";
// Not from '@/lib/actions/triage': that is a `"use server"` module, and a
// non-async export from one fails `next build` (#747).
import { MAX_BULK_TRIAGE } from "@/lib/triage/statuses";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    repository: { findFirst: vi.fn(), findMany: vi.fn() },
    findingTriage: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockAuth = vi.mocked(auth);
const mockRepoFindFirst = vi.mocked(prisma.repository.findFirst);
const mockRepoFindMany = vi.mocked(prisma.repository.findMany);
const mockTriageUpsert = vi.mocked(prisma.findingTriage.upsert);
const mockAuditCreate = vi.mocked(prisma.auditLog.create);
const mockTransaction = vi.mocked(prisma.$transaction);

const validInput = {
  repositoryId: "repo-1",
  fingerprint: "a".repeat(64),
  status: "FALSE_POSITIVE" as const,
  note: "  legit env var  ",
};

describe("setFindingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated callers without touching the DB", async () => {
    mockAuth.mockResolvedValue(null as never);

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(false);
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
    expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid status", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

    const result = await setFindingStatus({
      ...validInput,
      status: "BOGUS" as unknown as TriageStatus,
    });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findFirst).not.toHaveBeenCalled();
  });

  it("refuses to triage a repository the user does not own", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockRepoFindFirst.mockResolvedValue(null);

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Repository not found");
    expect(prisma.findingTriage.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("upserts the triage row and writes one audit log entry on success", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockRepoFindFirst.mockResolvedValue({ id: "repo-1", fullName: "acme/app" } as never);
    mockTriageUpsert.mockResolvedValue({} as never);
    mockAuditCreate.mockResolvedValue({} as never);

    const result = await setFindingStatus(validInput);

    expect(result.ok).toBe(true);

    // Keyed off the stable fingerprint via the composite unique constraint,
    // and the note is trimmed.
    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId_fingerprint: { repositoryId: "repo-1", fingerprint: validInput.fingerprint },
        },
        update: expect.objectContaining({
          status: "FALSE_POSITIVE",
          note: "legit env var",
          resolvedById: "user-1",
          expiresAt: null,
        }),
        create: expect.objectContaining({
          status: "FALSE_POSITIVE",
          note: "legit env var",
          resolvedById: "user-1",
          expiresAt: null,
        }),
      }),
    );

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          action: "FINDING TRIAGE",
          decision: "FALSE_POSITIVE",
        }),
      }),
    );
  });

  it("normalises a blank note to null", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockRepoFindFirst.mockResolvedValue({ id: "repo-1", fullName: "acme/app" } as never);
    mockTriageUpsert.mockResolvedValue({} as never);
    mockAuditCreate.mockResolvedValue({} as never);

    await setFindingStatus({ ...validInput, status: "OPEN", note: "   " });

    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ note: null }) }),
    );
  });
});

describe("setFindingStatuses", () => {
  const items = [
    { repositoryId: "repo-1", fingerprint: "a".repeat(64) },
    { repositoryId: "repo-1", fingerprint: "b".repeat(64) },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockTransaction.mockImplementation((async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)) as never);
  });

  it("rejects unauthenticated callers without touching the DB", async () => {
    mockAuth.mockResolvedValue(null as never);

    const result = await setFindingStatuses({ items, status: "IGNORED" });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid status", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

    const result = await setFindingStatuses({
      items,
      status: "BOGUS" as unknown as TriageStatus,
    });

    expect(result.ok).toBe(false);
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });

  it("rejects an empty item list", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);

    const result = await setFindingStatuses({ items: [], status: "IGNORED" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("No findings selected");
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });

  it("rejects more items than MAX_BULK_TRIAGE", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    const tooMany = Array.from({ length: MAX_BULK_TRIAGE + 1 }, (_, index) => ({
      repositoryId: "repo-1",
      fingerprint: `fp-${index}`,
    }));

    const result = await setFindingStatuses({ items: tooMany, status: "FALSE_POSITIVE" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Too many findings");
    expect(prisma.repository.findMany).not.toHaveBeenCalled();
  });

  it("refuses to triage a repository the user does not own", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockRepoFindMany.mockResolvedValue([]);

    const result = await setFindingStatuses({ items, status: "IGNORED" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Repository not found");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("upserts every finding and writes one audit log entry each", async () => {
    mockAuth.mockResolvedValue({ user: { id: "user-1" } } as never);
    mockRepoFindMany.mockResolvedValue([{ id: "repo-1", fullName: "acme/app" }] as never);
    mockTriageUpsert.mockResolvedValue({} as never);
    mockAuditCreate.mockResolvedValue({} as never);

    const result = await setFindingStatuses({
      items: [...items, items[0]],
      status: "FALSE_POSITIVE",
      note: "  noise  ",
    });

    expect(result.ok).toBe(true);
    expect(prisma.findingTriage.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    expect(prisma.findingTriage.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "FALSE_POSITIVE",
          note: "noise",
          resolvedById: "user-1",
          expiresAt: null,
        }),
      }),
    );
  });
});
