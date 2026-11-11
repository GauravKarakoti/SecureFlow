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
 *   npx tsx scripts/sync-threat-feed.ts --kev
 *   npx tsx scripts/sync-threat-feed.ts --kev --dry-run
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncCisaKevCatalog } from "../cli/src/threat-intel-feed";
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

  const syncKev = args.includes("--kev") || args.includes("--vulnerability-advisories");

  if (syncKev) {
    if (!isQuiet) {
      console.log("SecureFlow CISA Known Exploited Vulnerabilities Sync");
      console.log("=====================================================");
      console.log(`Dry Run Mode: ${isDryRun ? "YES (No writes)" : "NO"}`);
      console.log("Source: CISA Known Exploited Vulnerabilities Catalog");
    }

    const result = await syncCisaKevCatalog({ dryRun: isDryRun });

    if (!isQuiet) {
      console.log(`Catalog version: ${result.catalogVersion}`);
      console.log(`Date released: ${result.dateReleased}`);
      console.log(`Total vulnerabilities: ${result.totalVulnerabilities}`);
      console.log(`New vulnerabilities: ${result.newlyAdded}`);
      console.log(isDryRun ? "Dry run completed; no data was saved." : "Catalog synchronized.");
    }

    return 0;
  }

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

  // Dry runs must not leave a committable artifact in the repo root —
  // write to the OS temp dir and remove the file afterwards.
  const dryRunPath = isDryRun
    ? path.join(os.tmpdir(), `secureflow-dry-run-feed-${process.pid}.json`)
    : undefined;

  let result;
  try {
    result = await syncThreatFeeds({
      outputPath: dryRunPath ?? outputPath,
      sources: DEFAULT_THREAT_FEED_SOURCES,
    });
  } finally {
    if (dryRunPath) {
      fs.rmSync(dryRunPath, { force: true });
    }
  }

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

  return 0;
}

export { main as syncThreatFeedMain };

const isMain = process.argv[1] && /sync-threat-feed(\.ts|\.js)?$/.test(process.argv[1]);
if (isMain) {
  main()
    .then((code) => {
      process.exit(code ?? 0);
    })
    .catch((err) => {
      console.error("❌ Fatal error during threat feed sync:", err);
      process.exit(1);
    });
}
