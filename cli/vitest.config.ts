import { defineConfig } from "vitest/config";
import { FailedTestsReporter } from "../scripts/failed-tests-reporter.js";

export default defineConfig({
  css: { postcss: { plugins: [] } },
  test: {
    include: ["src/**/*.test.ts"],
    reporters: ["default", new FailedTestsReporter()],
  },
});
