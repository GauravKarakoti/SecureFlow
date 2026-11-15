import { defineConfig } from "vitest/config";
import { FailedTestsReporter } from "./scripts/failed-tests-reporter.js";

export default defineConfig({
  test: {
    reporters: ["default", new FailedTestsReporter()],
    server: {
      deps: {
        inline: ["genkitx-groq"],
      },
    },
    globals: true,
    environment: "node",
    include: [
      "*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "cli/src/**/*.test.ts",
      "tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(process.env.npm_lifecycle_event === "test:redteam" || process.env.REDTEAM === "true"
        ? []
        : ["**/*.redteam.test.ts", "**/*.redteam.test.tsx"]),
    ],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary", "json", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/app/**", "src/components/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: import.meta.dirname + "/src" },
      { find: "__mocks__", replacement: import.meta.dirname + "/__mocks__" },
      { find: "@armoriq/sdk", replacement: import.meta.dirname + "/__mocks__/@armoriq/sdk.ts" },
      { find: "next/server", replacement: import.meta.dirname + "/__mocks__/next/server.ts" },
      { find: "next/headers", replacement: import.meta.dirname + "/__mocks__/next/headers.ts" },
      {
        find: "next-auth/providers/github",
        replacement: import.meta.dirname + "/__mocks__/next-auth/providers/github.ts",
      },
      {
        find: "next-auth/react",
        replacement: import.meta.dirname + "/__mocks__/next-auth/index.ts",
      },
      {
        find: /^next-auth$/,
        replacement: import.meta.dirname + "/__mocks__/next-auth/index.ts",
      },
      {
        find: "secureflow-cli/contracts",
        replacement: import.meta.dirname + "/cli/src/contracts/index.ts",
      },
    ],
  },
});
