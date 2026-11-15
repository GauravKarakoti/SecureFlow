import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  getThreatIntelCacheWithSwr,
  setThreatIntelCache,
  verifyPayloadChecksum,
  computePayloadSha256,
} from "./threat-intel-cache.js";

export const CISA_KEV_FEED_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export const CISA_KEV_DATA_PATH = path.resolve(
  /*turbopackIgnore: true*/
  path.join(homedir(), ".secureflow", "threat-intel", "known_exploited_vulnerabilities.json"),
);

export const CISA_KEV_CHECKSUM_PATH = `${CISA_KEV_DATA_PATH}.sha256`;

const CATALOG_CACHE_KEY = "cisa-kev-catalog";
const CATALOG_TTL_SECONDS = 24 * 60 * 60; // 24 hours fresh TTL
const CATALOG_STALE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days stale fallback
const FETCH_TIMEOUT_MS = 15_000;

export interface CisaKevVulnerability {
  cveID: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  dateAdded: string;
  shortDescription: string;
  requiredAction: string;
  dueDate: string;
  knownRansomwareCampaignUse?: "Known" | "Unknown";
  forensicTriage?: "Yes" | "No";
  notes?: string;
  cwes?: string[];
}

export interface CisaKevCatalog {
  catalogVersion: string;
  dateReleased: string;
  count: number;
  vulnerabilities: CisaKevVulnerability[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isVulnerability(value: unknown): value is CisaKevVulnerability {
  if (!isRecord(value)) return false;

  const requiredStrings = [
    "cveID",
    "vendorProject",
    "product",
    "vulnerabilityName",
    "dateAdded",
    "shortDescription",
    "requiredAction",
    "dueDate",
  ];

  if (!requiredStrings.every((key) => typeof value[key] === "string")) {
    return false;
  }

  if (!/^CVE-\d{4}-\d{4,19}$/.test(value.cveID as string)) {
    return false;
  }

  if (
    value.cwes !== undefined &&
    (!Array.isArray(value.cwes) || !value.cwes.every((item) => typeof item === "string"))
  ) {
    return false;
  }

  return true;
}

export function isCisaKevCatalog(value: unknown): value is CisaKevCatalog {
  if (!isRecord(value)) return false;

  return (
    typeof value.catalogVersion === "string" &&
    typeof value.dateReleased === "string" &&
    Number.isFinite(Date.parse(value.dateReleased)) &&
    Number.isInteger(value.count) &&
    Array.isArray(value.vulnerabilities) &&
    value.count === value.vulnerabilities.length &&
    value.vulnerabilities.every(isVulnerability)
  );
}

/**
 * Load the last synchronized catalog from memory/Redis with SWR, or fall back to the local data file.
 * Verifies SHA-256 signatures before loading indicators into the scanner.
 */
export async function loadCisaKevCatalog(
  options: { populateCache?: boolean; allowStale?: boolean } = {},
): Promise<CisaKevCatalog | null> {
  try {
    const cachedResult = await getThreatIntelCacheWithSwr<unknown>(CATALOG_CACHE_KEY);

    if (cachedResult && isCisaKevCatalog(cachedResult.value)) {
      if (cachedResult.isStale && options.allowStale !== false) {
        console.warn(
          "⚠️  [SecureFlow Threat Intel] Serving stale CISA KEV threat catalog from cache. Background revalidation recommended.",
        );
      }
      return cachedResult.value;
    }
  } catch {
    // Continue to local copy if cache error occurs
  }

  try {
    const contents = await fs.readFile(/*turbopackIgnore: true*/ CISA_KEV_DATA_PATH, "utf8");

    // Cryptographic integrity check: verify SHA-256 checksum file if present
    try {
      const expectedChecksum = (
        await fs.readFile(/*turbopackIgnore: true*/ CISA_KEV_CHECKSUM_PATH, "utf8")
      ).trim();
      if (expectedChecksum && !verifyPayloadChecksum(contents, expectedChecksum)) {
        console.warn(
          "⚠️  [SecureFlow Threat Intel] Checksum verification failed for local CISA KEV feed file. Rejecting corrupted file.",
        );
        return null;
      }
    } catch {
      // If checksum file does not exist, compute and verify valid JSON structure
    }

    const parsed: unknown = JSON.parse(contents);

    if (!isCisaKevCatalog(parsed)) return null;

    if (options.populateCache !== false) {
      await setThreatIntelCache(
        CATALOG_CACHE_KEY,
        parsed,
        CATALOG_TTL_SECONDS,
        CATALOG_STALE_TTL_SECONDS,
      );
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Download, validate, hash, and persist the latest CISA KEV catalog.
 * The previous catalog is preserved if the request or validation fails.
 */
export async function syncCisaKevCatalog(options: { dryRun?: boolean } = {}): Promise<{
  catalogVersion: string;
  totalVulnerabilities: number;
  newlyAdded: number;
  dateReleased: string;
  sha256?: string;
}> {
  const dryRun = options.dryRun ?? false;
  const previous = await loadCisaKevCatalog({ populateCache: !dryRun });

  let response: Response;
  try {
    response = await fetch(CISA_KEV_FEED_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SecureFlow-Threat-Intelligence/1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Air-gapped / offline fallback: if local catalog exists, warn without failing hard
    if (previous) {
      console.warn(
        "⚠️  [SecureFlow Threat Intel] Network unreachable or timeout while fetching CISA KEV feed. Falling back to local/cached feed data.",
      );
      return {
        catalogVersion: previous.catalogVersion,
        totalVulnerabilities: previous.count,
        newlyAdded: 0,
        dateReleased: previous.dateReleased,
      };
    }
    throw error;
  }

  if (!response.ok) {
    if (previous) {
      console.warn(
        `⚠️  [SecureFlow Threat Intel] CISA KEV feed returned HTTP ${response.status}. Falling back to cached catalog.`,
      );
      return {
        catalogVersion: previous.catalogVersion,
        totalVulnerabilities: previous.count,
        newlyAdded: 0,
        dateReleased: previous.dateReleased,
      };
    }
    throw new Error(`CISA KEV feed returned HTTP ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error("CISA KEV feed returned invalid non-JSON payload");
  }

  if (!isCisaKevCatalog(payload)) {
    throw new Error("CISA KEV feed returned an invalid or incomplete catalog");
  }

  const payloadSha256 = computePayloadSha256(rawText);
  const previousIds = new Set((previous?.vulnerabilities ?? []).map((item) => item.cveID));
  const newlyAdded = payload.vulnerabilities.filter((item) => !previousIds.has(item.cveID)).length;

  if (!dryRun) {
    await fs.mkdir(path.dirname(CISA_KEV_DATA_PATH), { recursive: true });

    const temporaryPath = `${CISA_KEV_DATA_PATH}.${process.pid}.tmp`;
    const temporaryChecksumPath = `${CISA_KEV_CHECKSUM_PATH}.${process.pid}.tmp`;

    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
      await fs.writeFile(temporaryChecksumPath, `${payloadSha256}\n`, "utf8");

      await fs.rename(temporaryPath, CISA_KEV_DATA_PATH);
      await fs.rename(temporaryChecksumPath, CISA_KEV_CHECKSUM_PATH);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      await fs.rm(temporaryChecksumPath, { force: true });
      throw error;
    }

    await setThreatIntelCache(
      CATALOG_CACHE_KEY,
      payload,
      CATALOG_TTL_SECONDS,
      CATALOG_STALE_TTL_SECONDS,
    );
  }

  return {
    catalogVersion: payload.catalogVersion,
    totalVulnerabilities: payload.count,
    newlyAdded,
    dateReleased: payload.dateReleased,
    sha256: payloadSha256,
  };
}

/**
 * Search only the CISA KEV catalog. Absence from KEV does not mean a CVE is safe.
 */
export async function searchCisaKevCatalog(
  query: string,
  limit = 20,
): Promise<CisaKevVulnerability[]> {
  const normalized = query.trim().toLowerCase();

  if (!normalized || normalized.length > 200) return [];

  const catalog = await loadCisaKevCatalog();

  if (!catalog) return [];

  return catalog.vulnerabilities
    .filter((item) => {
      const searchable = [
        item.cveID,
        item.vendorProject,
        item.product,
        item.vulnerabilityName,
        item.shortDescription,
        item.requiredAction,
        item.notes ?? "",
        ...(item.cwes ?? []),
      ];

      return searchable.some((field) => field.toLowerCase().includes(normalized));
    })
    .slice(0, Math.max(1, Math.min(limit, 50)));
}

export async function lookupCisaKevEntry(cveId: string): Promise<CisaKevVulnerability | null> {
  const normalized = cveId.trim().toUpperCase();

  if (!/^CVE-\d{4}-\d{4,19}$/.test(normalized)) return null;

  const catalog = await loadCisaKevCatalog();

  if (!catalog) {
    throw new Error("CISA KEV catalog unavailable. Run the vulnerability feed sync first.");
  }

  return catalog.vulnerabilities.find((item) => item.cveID.toUpperCase() === normalized) ?? null;
}

export interface OsvLiveAdvisory {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  modified?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: unknown[];
}

function isOsvLiveAdvisory(value: unknown): value is OsvLiveAdvisory {
  return isRecord(value) && typeof value.id === "string" && /^CVE-\d{4}-\d{4,19}$/i.test(value.id);
}

/**
 * Fetch an individual CVE from OSV.dev, using SWR cache before making a network call.
 * In air-gapped mode or network errors, serves cached stale entries with warning.
 */
export async function lookupOsvAdvisory(cveId: string): Promise<OsvLiveAdvisory | null> {
  const normalized = cveId.trim().toUpperCase();

  if (!/^CVE-\d{4}-\d{4,19}$/.test(normalized)) return null;

  const cacheKey = `osv-advisory-${normalized}`;

  const cachedResult = await getThreatIntelCacheWithSwr<unknown>(cacheKey);
  if (cachedResult && isOsvLiveAdvisory(cachedResult.value)) {
    if (!cachedResult.isStale) {
      return cachedResult.value;
    }
  }

  try {
    const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(normalized)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status === 404) return null;

    if (!response.ok) {
      if (cachedResult && isOsvLiveAdvisory(cachedResult.value)) {
        console.warn(
          `⚠️  [SecureFlow Threat Intel] OSV endpoint returned HTTP ${response.status}. Using stale cached advisory for ${normalized}.`,
        );
        return cachedResult.value;
      }
      throw new Error(`OSV lookup failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload: unknown = await response.json();

    if (!isOsvLiveAdvisory(payload)) {
      throw new Error("OSV returned an invalid vulnerability record");
    }

    await setThreatIntelCache(cacheKey, payload, CATALOG_TTL_SECONDS, CATALOG_STALE_TTL_SECONDS);

    return payload;
  } catch (error) {
    // Air-gapped fallback
    if (cachedResult && isOsvLiveAdvisory(cachedResult.value)) {
      console.warn(
        `⚠️  [SecureFlow Threat Intel] Network unreachable for OSV query. Falling back to cached advisory for ${normalized}.`,
      );
      return cachedResult.value;
    }
    throw error;
  }
}
