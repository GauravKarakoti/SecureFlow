import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:9002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: {
    command: process.env.CI ? 'npm run build && npm run start -- -p 9002' : 'npm run dev',
    url: process.env.E2E_BASE_URL || 'http://localhost:9002',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // ⭐ NEW: Auth.js configuration for E2E test server
      AUTH_TRUST_HOST: 'true',
      NEXTAUTH_TRUST_HOST: 'true',
      AUTH_URL: process.env.E2E_BASE_URL || 'http://localhost:9002',
      NEXTAUTH_URL: process.env.E2E_BASE_URL || 'http://localhost:9002',
      AUTH_SECRET: 'e2e-test-secret-key',
      NEXTAUTH_SECRET: 'e2e-test-secret-key',
      NEXT_PUBLIC_MOCK_DB: 'true',
      NEXT_PUBLIC_MOCK_AUTH: 'true',
      GITHUB_WEBHOOK_SECRET: 'e2e-webhook-secret',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});