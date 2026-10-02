#!/usr/bin/env tsx
/**
 * Automated Threat Feed Synchronizer for SecureFlow Red-Team Guardrails.
 *
 * Fetches, parses, normalizes, and categorizes prompt injection and jailbreak payloads
 * from configured external threat feeds and updates the local corpus.
 *
 * Usage:
 *   npx tsx scripts/sync-threat-feed.ts
 *   npx tsx scripts/sync-threat-feed.ts --dry-run
 *   npx tsx scripts/sync-threat-feed.ts --out custom-path.json
 */

import path from "node:path";
import {
  DEFAULT_FEED_PATH,
  DEFAULT_THREAT_FEED_SOURCES,
  syncThreatFeeds,
  loadThreatFeedDataset,
} from "../src/lib/security/threat-feed";

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isQuiet = args.includes("--quiet");
  const outIndex = args.indexOf("--out");
  const outputPath =
    outIndex !== -1 && args[outIndex + 1]
      ? path.resolve(process.cwd(), args[outIndex + 1])
      : DEFAULT_FEED_PATH;

  if (!isQuiet) {
    console.log("🛡️  SecureFlow Red-Team Threat Feed Synchronizer");
    console.log("==================================================");
    console.log(`Target Dataset: ${outputPath}`);
    console.log(`Dry Run Mode:   ${isDryRun ? "YES (No writes)" : "NO"}`);
    console.log(`Configured Sources: ${DEFAULT_THREAT_FEED_SOURCES.length}`);
    DEFAULT_THREAT_FEED_SOURCES.forEach((s) => {
      console.log(`  - [${s.enabled ? "ACTIVE" : "DISABLED"}] ${s.name} (${s.url})`);
    });
    console.log("--------------------------------------------------");
    console.log("Fetching and merging threat feeds...");
  }

  const initialDataset = loadThreatFeedDataset(outputPath);
  const initialCount = (initialDataset.payloads || []).length;

  const result = await syncThreatFeeds({
    outputPath: isDryRun ? path.resolve(process.cwd(), "tmp_dry_run_feed.json") : outputPath,
    sources: DEFAULT_THREAT_FEED_SOURCES,
  });

  if (!isQuiet) {
    console.log("\n📊 Synchronization Summary:");
    console.log(`  • Status:           ${result.success ? "SUCCESS" : "PARTIAL / WITH WARNINGS"}`);
    console.log(`  • Baseline Payloads: ${initialCount}`);
    console.log(`  • Total Payloads:    ${result.totalPayloads}`);
    console.log(`  • New Added:         ${result.newPayloadsAdded}`);
    console.log(`  • Sources Synced:    ${result.sourcesSynced.join(", ") || "None"}`);

    if (result.errors.length > 0) {
      console.log("\n⚠️  Warnings / Errors encountered:");
      result.errors.forEach((err) => console.log(`  - ${err}`));
    }

    console.log("\n📈 Category Breakdown:");
    Object.entries(result.categoryCounts)
      .sort(([, a], [, b]) => b - a)
      .forEach(([category, count]) => {
        const bar = "█".repeat(Math.min(30, Math.ceil(count / 2)));
        console.log(`  • ${category.padEnd(35)} ${String(count).padStart(3)} ${bar}`);
      });

    console.log("\n✅ Red-team dataset is up to date.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal error during threat feed sync:", err);
  process.exit(1);
});
