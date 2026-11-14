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
    // cli/** is included so the pre-commit hook's detector is covered by the
    // same `npm test` the husky hook already runs. Coverage `include` below is
    // deliberately left at src/**, so the CLI does not move the thresholds.
    include: [
      "*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "cli/src/**/*.test.ts",
      "tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.redteam.test.ts", "**/*.redteam.test.tsx"],
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15000,
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
    alias: {
      "@": import.meta.dirname + "/src",
      __mocks__: import.meta.dirname + "/__mocks__",
      "@armoriq/sdk": import.meta.dirname + "/__mocks__/@armoriq/sdk.ts",
      "next/server": import.meta.dirname + "/__mocks__/next/server.ts",
      "next/headers": import.meta.dirname + "/__mocks__/next/headers.ts",
      "next-auth": import.meta.dirname + "/__mocks__/next-auth/index.ts",
      zod: import.meta.dirname + "/cli/node_modules/zod/index.js",
      "secureflow-cli/contracts": import.meta.dirname + "/cli/src/contracts/index.ts",
    },
  },
});
