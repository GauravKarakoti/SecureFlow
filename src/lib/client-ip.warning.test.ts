import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fresh module per test: the warning is once-per-process by design.
async function load() {
  vi.resetModules();
  return import("./client-ip");
}

describe("getClientIp — unconfigured proxy warning", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "");
    vi.stubEnv("TRUSTED_PROXY_IPS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it("warns once when forwarding headers arrive and nothing is configured", async () => {
    const { getClientIp, UNKNOWN_CLIENT_IP } = await load();

    expect(getClientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe(UNKNOWN_CLIENT_IP);
    expect(getClientIp(new Headers({ "x-real-ip": "5.6.7.8" }))).toBe(UNKNOWN_CLIENT_IP);

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("TRUSTED_PROXY_HOP_COUNT");
  });

  it("stays quiet when the operator explicitly chose 0", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "0");
    const { getClientIp } = await load();

    getClientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }));

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet without forwarding headers, when there is nothing to misread", async () => {
    const { getClientIp } = await load();

    getClientIp(new Headers());

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when a hop count is configured", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "1");
    const { getClientIp } = await load();

    expect(getClientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet when the caller passes explicit options", async () => {
    const { getClientIp } = await load();

    getClientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }), {
      trustedHopCount: 0,
      trustedProxies: [],
    });

    expect(warn).not.toHaveBeenCalled();
  });
});
