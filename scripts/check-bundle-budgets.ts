import fs from "node:fs";
import path from "node:path";

export interface RouteBudgetEntry {
  budgetKb: number;
  baselineKb?: number;
  description?: string;
}

export interface BundleBudgetSettings {
  maxRouteGrowthPercent: number;
  maxRouteGrowthKb: number;
  unit?: string;
}

export interface BundleBudgetConfig {
  name?: string;
  version?: number;
  description?: string;
  settings: BundleBudgetSettings;
  routes: Record<string, RouteBudgetEntry>;
}

export interface RouteEvaluation {
  route: string;
  actualKb: number;
  baselineKb?: number;
  budgetKb: number;
  growthPercent?: number;
  growthKb?: number;
  passed: boolean;
  status: "PASS" | "EXCEEDED_BUDGET" | "EXCEEDED_GROWTH";
  message?: string;
}

export interface BudgetEvaluationResult {
  passed: boolean;
  totalRoutes: number;
  passedRoutes: number;
  failedRoutes: number;
  evaluations: RouteEvaluation[];
}

/**
 * Load bundle budget configuration from disk.
 */
export function loadBudgetConfig(
  configPath: string = path.resolve(process.cwd(), "bundle-budget.json"),
): BundleBudgetConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Budget configuration file not found at: ${configPath}`);
  }
  const content = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(content) as BundleBudgetConfig;
}

/**
 * Parse per-route JavaScript bundle sizes from Next.js build manifests.
 */
export function parseRouteSizesFromManifest(
  nextDir: string = path.resolve(process.cwd(), ".next"),
): Record<string, number> {
  const routeSizes: Record<string, number> = {};
  const appBuildManifestPath = path.join(nextDir, "app-build-manifest.json");
  const buildManifestPath = path.join(nextDir, "build-manifest.json");

  // App router manifest parsing
  if (fs.existsSync(appBuildManifestPath)) {
    try {
      const appManifest = JSON.parse(fs.readFileSync(appBuildManifestPath, "utf-8"));
      const pages = appManifest.pages || {};

      for (const [appRoute, chunks] of Object.entries(pages)) {
        // Normalize "/page" -> "/", "/dashboard/page" -> "/dashboard"
        let normalizedRoute = appRoute.replace(/\/page$/, "");
        if (normalizedRoute === "") normalizedRoute = "/";

        const chunkList = Array.isArray(chunks) ? (chunks as string[]) : [];
        let totalBytes = 0;
        const countedFiles = new Set<string>();

        for (const chunk of chunkList) {
          if (!countedFiles.has(chunk)) {
            countedFiles.add(chunk);
            const chunkPath = path.join(nextDir, chunk);
            if (fs.existsSync(chunkPath)) {
              totalBytes += fs.statSync(chunkPath).size;
            }
          }
        }

        const sizeKb = Math.round((totalBytes / 1024) * 10) / 10;
        routeSizes[normalizedRoute] = sizeKb;
      }
    } catch (err) {
      console.warn(`Warning: Could not parse ${appBuildManifestPath}:`, err);
    }
  }

  // Fallback or supplementary Pages router manifest parsing
  if (fs.existsSync(buildManifestPath)) {
    try {
      const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
      const pages = buildManifest.pages || {};
      const rootChunks: string[] = buildManifest.rootMainFiles || [];

      for (const [pageRoute, chunks] of Object.entries(pages)) {
        if (!routeSizes[pageRoute]) {
          const chunkList = [...rootChunks, ...(Array.isArray(chunks) ? (chunks as string[]) : [])];
          let totalBytes = 0;
          const countedFiles = new Set<string>();

          for (const chunk of chunkList) {
            if (!countedFiles.has(chunk)) {
              countedFiles.add(chunk);
              const chunkPath = path.join(nextDir, chunk);
              if (fs.existsSync(chunkPath)) {
                totalBytes += fs.statSync(chunkPath).size;
              }
            }
          }

          routeSizes[pageRoute] = Math.round((totalBytes / 1024) * 10) / 10;
        }
      }
    } catch (err) {
      console.warn(`Warning: Could not parse ${buildManifestPath}:`, err);
    }
  }

  return routeSizes;
}

/**
 * Evaluates measured route sizes against stored budgets and growth thresholds.
 */
export function evaluateRouteBudgets(
  routeSizes: Record<string, number>,
  config: BundleBudgetConfig,
): BudgetEvaluationResult {
  const evaluations: RouteEvaluation[] = [];
  const { maxRouteGrowthPercent, maxRouteGrowthKb } = config.settings;

  for (const [route, entry] of Object.entries(config.routes)) {
    // If route was measured, use actual size; if not yet built or absent, default to baseline or 0
    const actualKb = routeSizes[route] ?? entry.baselineKb ?? 0;
    const baselineKb = entry.baselineKb;
    const budgetKb = entry.budgetKb;

    let growthKb: number | undefined;
    let growthPercent: number | undefined;

    if (typeof baselineKb === "number" && baselineKb > 0) {
      growthKb = Math.round((actualKb - baselineKb) * 10) / 10;
      growthPercent = Math.round(((actualKb - baselineKb) / baselineKb) * 1000) / 10;
    }

    let status: "PASS" | "EXCEEDED_BUDGET" | "EXCEEDED_GROWTH" = "PASS";
    let message: string | undefined;

    if (actualKb > budgetKb) {
      status = "EXCEEDED_BUDGET";
      const overKb = (actualKb - budgetKb).toFixed(1);
      message = `Exceeded max budget: ${actualKb.toFixed(1)} kB > ${budgetKb} kB (+${overKb} kB)`;
    } else if (
      typeof growthKb === "number" &&
      typeof growthPercent === "number" &&
      growthKb > maxRouteGrowthKb &&
      growthPercent > maxRouteGrowthPercent
    ) {
      status = "EXCEEDED_GROWTH";
      message = `Exceeded growth threshold: +${growthKb.toFixed(1)} kB (+${growthPercent.toFixed(1)}% > ${maxRouteGrowthPercent}%)`;
    }

    evaluations.push({
      route,
      actualKb,
      baselineKb,
      budgetKb,
      growthKb,
      growthPercent,
      passed: status === "PASS",
      status,
      message,
    });
  }

  const passedRoutes = evaluations.filter((e) => e.passed).length;
  const failedRoutes = evaluations.filter((e) => !e.passed).length;

  return {
    passed: failedRoutes === 0,
    totalRoutes: evaluations.length,
    passedRoutes,
    failedRoutes,
    evaluations,
  };
}

/**
 * Format the evaluation report into a readable ASCII table.
 */
export function formatBudgetReportTable(result: BudgetEvaluationResult): string {
  const lines: string[] = [];
  lines.push(
    "╔══════════════════════════╦═════════════╦══════════════╦═════════════╦═════════════════════╗",
  );
  lines.push(
    "║ Route                    ║ Actual (kB) ║ Baseline(kB) ║ Budget (kB) ║ Status              ║",
  );
  lines.push(
    "╠══════════════════════════╬═════════════╬══════════════╬═════════════╬═════════════════════╣",
  );

  for (const evalItem of result.evaluations) {
    const routeCol = evalItem.route.padEnd(24);
    const actualCol = `${evalItem.actualKb.toFixed(1)} kB`.padEnd(11);
    const baselineCol = (
      evalItem.baselineKb ? `${evalItem.baselineKb.toFixed(1)} kB` : "N/A"
    ).padEnd(12);
    const budgetCol = `${evalItem.budgetKb.toFixed(1)} kB`.padEnd(11);
    const statusLabel = evalItem.passed ? "✅ PASS" : "❌ FAIL";
    const statusCol = statusLabel.padEnd(19);

    lines.push(`║ ${routeCol} ║ ${actualCol} ║ ${baselineCol} ║ ${budgetCol} ║ ${statusCol} ║`);

    if (!evalItem.passed && evalItem.message) {
      lines.push(`║   ↳ ⚠️ ${evalItem.message.padEnd(80)}║`);
    }
  }

  lines.push(
    "╚══════════════════════════╩═════════════╩══════════════╩═════════════╩═════════════════════╝",
  );
  return lines.join("\n");
}

export function runBundleBudgetCheck(configPath?: string, nextDir?: string): boolean {
  console.log("🔍 Checking JavaScript bundle size budgets against stored configuration...");

  try {
    const config = loadBudgetConfig(configPath);
    const routeSizes = parseRouteSizesFromManifest(nextDir);
    const result = evaluateRouteBudgets(routeSizes, config);

    console.log("\n" + formatBudgetReportTable(result) + "\n");

    if (!result.passed) {
      console.error(
        `❌ BUNDLE BUDGET FAILED: ${result.failedRoutes} of ${result.totalRoutes} routes exceeded JavaScript size budgets.\n`,
      );
      for (const failure of result.evaluations.filter((e) => !e.passed)) {
        console.error(`  - ${failure.route}: ${failure.message}`);
      }
      console.error("\nTo adjust budgets, see guidelines in CONTRIBUTING.md with justification.");
      return false;
    }

    console.log(
      `✅ BUNDLE BUDGET PASSED: All ${result.passedRoutes} routes are within acceptable JavaScript size limits.`,
    );
    return true;
  } catch (error) {
    console.error("❌ Error executing bundle budget check:", error);
    return false;
  }
}

// Direct execution entrypoint
if (process.argv[1] && process.argv[1].endsWith("check-bundle-budgets.ts")) {
  const success = runBundleBudgetCheck();
  if (!success) {
    process.exit(1);
  }
}
