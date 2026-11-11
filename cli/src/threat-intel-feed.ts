import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { getThreatIntelCache, setThreatIntelCache } from "./threat-intel-cache.js";

export const CISA_KEV_FEED_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export const CISA_KEV_DATA_PATH = path.resolve(
  process.env.SECUREFLOW_KEV_CACHE_PATH?.trim() ||
    path.join(homedir(), ".secureflow", "threat-intel", "known_exploited_vulnerabilities.json"),
);

const CATALOG_CACHE_KEY = "cisa-kev-catalog";
const CATALOG_TTL_SECONDS = 24 * 60 * 60;
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

function isCisaKevCatalog(value: unknown): value is CisaKevCatalog {
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
 * Load the last synchronized catalog from Redis or the local data file.
 */
export async function loadCisaKevCatalog(
  options: { populateCache?: boolean } = {},
): Promise<CisaKevCatalog | null> {
  try {
    const cached = await getThreatIntelCache<unknown>(CATALOG_CACHE_KEY);

    if (isCisaKevCatalog(cached)) return cached;
  } catch {
    // Continue to the local copy if Redis is unavailable.
  }

  try {
    const contents = await fs.readFile(CISA_KEV_DATA_PATH, "utf8");
    const parsed: unknown = JSON.parse(contents);

    if (!isCisaKevCatalog(parsed)) return null;

    if (options.populateCache !== false) {
      await setThreatIntelCache(CATALOG_CACHE_KEY, parsed, CATALOG_TTL_SECONDS);
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Download, validate and persist the latest CISA KEV catalog.
 * The previous catalog is preserved if the request or validation fails.
 */
export async function syncCisaKevCatalog(options: { dryRun?: boolean } = {}): Promise<{
  catalogVersion: string;
  totalVulnerabilities: number;
  newlyAdded: number;
  dateReleased: string;
}> {
  const dryRun = options.dryRun ?? false;
  const previous = await loadCisaKevCatalog({ populateCache: !dryRun });

  const response = await fetch(CISA_KEV_FEED_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "SecureFlow-Threat-Intelligence/1.0",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`CISA KEV feed returned HTTP ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();

  if (!isCisaKevCatalog(payload)) {
    throw new Error("CISA KEV feed returned an invalid or incomplete catalog");
  }

  const previousIds = new Set((previous?.vulnerabilities ?? []).map((item) => item.cveID));

  const newlyAdded = payload.vulnerabilities.filter((item) => !previousIds.has(item.cveID)).length;

  if (!dryRun) {
    await fs.mkdir(path.dirname(CISA_KEV_DATA_PATH), { recursive: true });

    const temporaryPath = `${CISA_KEV_DATA_PATH}.${process.pid}.tmp`;

    try {
      await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

      await fs.rename(temporaryPath, CISA_KEV_DATA_PATH);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }

    await setThreatIntelCache(CATALOG_CACHE_KEY, payload, CATALOG_TTL_SECONDS);
  }

  return {
    catalogVersion: payload.catalogVersion,
    totalVulnerabilities: payload.count,
    newlyAdded,
    dateReleased: payload.dateReleased,
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
 * Fetch an individual CVE from OSV.dev, using Redis before making a network call.
 * Throws on network/API failures so callers can distinguish outages from 404s.
 */
export async function lookupOsvAdvisory(cveId: string): Promise<OsvLiveAdvisory | null> {
  const normalized = cveId.trim().toUpperCase();

  if (!/^CVE-\d{4}-\d{4,19}$/.test(normalized)) return null;

  const cacheKey = `osv-advisory-${normalized}`;

  const cached = await getThreatIntelCache<unknown>(cacheKey);
  if (isOsvLiveAdvisory(cached)) return cached;

  const response = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(normalized)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`OSV lookup failed: HTTP ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();

  if (!isOsvLiveAdvisory(payload)) {
    throw new Error("OSV returned an invalid vulnerability record");
  }

  await setThreatIntelCache(cacheKey, payload, CATALOG_TTL_SECONDS);

  return payload;
}
