import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The `failed` listener decides which outbound deliveries end up in the DLQ,
 * which is what `/admin/queue` shows for a webhook that will never arrive.
 * `processOutboundWebhook` is covered in `outboundWorker.test.ts`; this file
 * covers the listener, which was never exercised.
 */

const { handlers, dlqAdd } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  dlqAdd: vi.fn(),
}));

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  class FakeWorker {
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
      return this;
    }
  }
  return { ...actual, Worker: FakeWorker };
});

vi.mock("./redis", () => ({ redis: {} }));

vi.mock("./outboundWebhookQueue", () => ({
  outboundWebhookDLQ: { add: dlqAdd },
}));

import { UnrecoverableError } from "bullmq";
import "./outboundWorker";

const failed = (job: unknown, err: Error) => handlers.get("failed")!(job, err);

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-7",
    attemptsMade: 1,
    opts: { attempts: 3 },
    data: { url: "https://hooks.example.com/x", payload: { event: "scan" } },
    ...overrides,
  };
}

describe("outboundWorker 'failed' listener", () => {
  beforeEach(() => {
    dlqAdd.mockReset();
    dlqAdd.mockResolvedValue(undefined);
  });

  it("registers completed and failed listeners", () => {
    expect(handlers.has("completed")).toBe(true);
    expect(handlers.has("failed")).toBe(true);
  });

  it("does nothing for a job that still has attempts left", async () => {
    await failed(job({ attemptsMade: 1 }), new Error("503 Service Unavailable"));
    expect(dlqAdd).not.toHaveBeenCalled();
  });

  it("routes a job to the DLQ once its attempts are exhausted", async () => {
    const exhausted = job({ attemptsMade: 3 });

    await failed(exhausted, new Error("503 Service Unavailable"));

    expect(dlqAdd).toHaveBeenCalledTimes(1);
    const [name, entry, opts] = dlqAdd.mock.calls[0];
    expect(name).toBe("dispatch-webhook-dlq");
    expect(entry).toMatchObject({
      originalJobId: "job-7",
      data: exhausted.data,
      failedReason: "503 Service Unavailable",
      attemptsMade: 3,
      unrecoverable: false,
    });
    expect(new Date(entry.failedAt).toString()).not.toBe("Invalid Date");
    expect(opts).toEqual({ attempts: 1 });
  });

  it("routes an UnrecoverableError to the DLQ on the first attempt", async () => {
    await failed(job({ attemptsMade: 1 }), new UnrecoverableError("410 Gone"));

    expect(dlqAdd).toHaveBeenCalledTimes(1);
    expect(dlqAdd.mock.calls[0][1]).toMatchObject({
      unrecoverable: true,
      failedReason: "410 Gone",
    });
  });

  it("defaults to three attempts when the job carries none", async () => {
    await failed(job({ attemptsMade: 2, opts: {} }), new Error("timeout"));
    expect(dlqAdd).not.toHaveBeenCalled();

    await failed(job({ attemptsMade: 3, opts: {} }), new Error("timeout"));
    expect(dlqAdd).toHaveBeenCalledTimes(1);
  });

  it("ignores a failure event with no job", async () => {
    await failed(undefined, new Error("stalled"));
    expect(dlqAdd).not.toHaveBeenCalled();
  });

  it("swallows a DLQ write failure rather than crashing the worker", async () => {
    dlqAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(failed(job({ attemptsMade: 3 }), new Error("503"))).resolves.toBeUndefined();
  });
});
