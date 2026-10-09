import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.AUTH_URL || "http://localhost:9002",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  webServer: {
    command: process.env.CI ? "npm run build && npm run start -- -p 9002" : "npm run dev",
    url: process.env.AUTH_URL || "http://localhost:9002",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://ci:ci@localhost:5432/secureflow",
      DATABASE_POOL_URL:
        process.env.DATABASE_POOL_URL ||
        process.env.DATABASE_URL ||
        "postgresql://ci:ci@localhost:5432/secureflow",
      GROQ_API_KEY: process.env.GROQ_API_KEY || "ci-build-placeholder",
      GITHUB_APP_ID: process.env.GITHUB_APP_ID || "1",
      GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET || "e2e-webhook-secret",
      GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY || "ci-build-placeholder",
      GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || "ci-build-placeholder",
      GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || "ci-build-placeholder",
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:9002",
      // ⭐ Auth.js configuration for E2E test server
      AUTH_TRUST_HOST: "true",
      NEXTAUTH_TRUST_HOST: "true",
      AUTH_URL: process.env.AUTH_URL || "http://localhost:9002",
      NEXTAUTH_URL: process.env.AUTH_URL || "http://localhost:9002",
      AUTH_SECRET: process.env.AUTH_SECRET || "e2e-test-secret-key",
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || "e2e-test-secret-key",
      NEXT_PUBLIC_MOCK_DB: "true",
      NEXT_PUBLIC_MOCK_AUTH: "true",
      // Server-only opt-in required alongside NEXT_PUBLIC_MOCK_AUTH so the mock
      ALLOW_MOCK_AUTH: "true",
    },
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Safari",
      use: { ...devices["Mobile Safari"] },
    },
    {
      name: "Pixel 5",
      use: { ...devices["Pixel 5"] },
    },
  ],
});
