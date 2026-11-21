import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "./route";
import cliPackageJson from "../../../../cli/package.json";

describe("GET /api/version", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.GIT_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_GIT_COMMIT_SHA;
    delete process.env.BUILD_DATE;
    delete process.env.NEXT_PUBLIC_BUILD_DATE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns 200 OK with version, commit, and buildDate", async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty("version");
    expect(data).toHaveProperty("commit");
    expect(data).toHaveProperty("buildDate");

    expect(typeof data.version).toBe("string");
    expect(typeof data.commit).toBe("string");
    expect(typeof data.buildDate).toBe("string");

    // Defaults to CLI package version
    expect(data.version).toBe(cliPackageJson.version);
    expect(data.commit).toBe("development");
    expect(data.buildDate).toBe("unknown");
  });

  it("returns injected environment variables when configured at build/run time", async () => {
    process.env.APP_VERSION = "1.2.3";
    process.env.GIT_COMMIT_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    process.env.BUILD_DATE = "2026-11-20T12:00:00.000Z";

    const res = await GET();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.version).toBe("1.2.3");
    expect(data.commit).toBe("abcdef1234567890abcdef1234567890abcdef12");
    expect(data.buildDate).toBe("2026-11-20T12:00:00.000Z");
  });

  it("supports NEXT_PUBLIC_* prefixed build variables", async () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "2.0.0-rc.1";
    process.env.NEXT_PUBLIC_GIT_COMMIT_SHA = "9876543210fedcba";
    process.env.NEXT_PUBLIC_BUILD_DATE = "2026-11-21T08:30:00Z";

    const res = await GET();
    const data = await res.json();

    expect(data.version).toBe("2.0.0-rc.1");
    expect(data.commit).toBe("9876543210fedcba");
    expect(data.buildDate).toBe("2026-11-21T08:30:00Z");
  });

  it("contains strictly no secrets, internal filesystem paths, or dependency lists", async () => {
    // Set typical sensitive environment variables
    process.env.DATABASE_URL = "postgresql://user:secretpassword@localhost:5432/secureflow";
    process.env.GROQ_API_KEY = "gsk_live_secret_key_123456789";
    process.env.GITHUB_WEBHOOK_SECRET = "whsec_supersecret";

    const res = await GET();
    const data = await res.json();
    const rawJson = JSON.stringify(data);

    // Only expected fields
    expect(Object.keys(data).sort()).toEqual(["buildDate", "commit", "version"]);

    // Ensure no secrets appear
    expect(rawJson).not.toContain("secretpassword");
    expect(rawJson).not.toContain("gsk_live");
    expect(rawJson).not.toContain("whsec_");
    expect(rawJson).not.toContain("postgresql://");

    // Ensure no internal paths appear
    expect(rawJson).not.toContain("C:\\");
    expect(rawJson).not.toContain("/home/");
    expect(rawJson).not.toContain("/app/");
    expect(rawJson).not.toContain("node_modules");

    // Ensure no dependency lists appear
    expect(data).not.toHaveProperty("dependencies");
    expect(data).not.toHaveProperty("devDependencies");
  });

  it("returns cache-control header for edge and browser caching", async () => {
    const res = await GET();
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=");
  });
});
