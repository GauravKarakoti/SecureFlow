import { gzipSync } from "node:zlib";
import { normalizeFindingType, type FindingCategory } from "@/lib/finding-taxonomy";
import { storedSeverityRank, toStoredSeverity, type StoredSeverity } from "@/lib/severity";

/**
 * Publishing scan results to GitHub's native Code Scanning UI.
 *
 * `cli/src/sarif.ts` also produces SARIF, but from the CLI scanner's own
 * `FileScanResult[]` and only for its console-secret-logging rules. Server
 * findings are a different shape entirely (type, severity, fileLocation,
 * fingerprint, AI-written explanation), so the two builders stay separate
 * rather than one growing a union of both worlds.
 *
 * The upload endpoint is documented at
 * https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data
 * and requires the installation to hold `security_events: write` — shown in the
 * GitHub App settings UI as "Code scanning alerts: Read & Write".
 */

/** SARIF severity levels GitHub recognises. */
export type SarifLevel = "error" | "warning" | "note";

/** The subset of a server finding this module needs. */
export interface CodeScanningFinding {
  type?: unknown;
  severity?: unknown;
  fileLocation?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  description?: string | null;
  explanation?: string | null;
  remediation?: string | null;
  fingerprint?: string | null;
}

export interface SarifDocument {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  automationDetails?: { id: string };
  results: SarifResult[];
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties: { tags: string[]; "security-severity": string };
  helpUri: string;
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region?: { startLine: number; endLine?: number };
    };
  }>;
  partialFingerprints?: Record<string, string>;
}

const TOOL_NAME = "SecureFlow";

/**
 * Reported to GitHub as the analysing tool's version, and shown on the alert.
 * Kept in step with `package.json` by hand — it is a label, not a dependency,
 * and importing the manifest into a worker bundle to read one string is a
 * poor trade.
 */
const TOOL_VERSION = "0.1.0";
const INFORMATION_URI = "https://github.com/GauravKarakoti/SecureFlow";

/**
 * Key under which our own fingerprint travels.
 *
 * GitHub uses `partialFingerprints` to recognise an alert it has already seen.
 * Without one it falls back to the surrounding snippet, so a finding that
 * merely shifted down a few lines reopens as a brand new alert and any triage
 * a developer did on it is lost. `computeFingerprint` already gives us a
 * stable identity across commits, which is exactly what this field wants.
 */
export const FINGERPRINT_KEY = "secureflow/finding/v1";

/**
 * GitHub keeps the top 5,000 results by severity and the endpoint rejects
 * anything past 25,000, so the cap is applied here — severity-ordered — rather
 * than letting the server decide which findings survive.
 */
export const MAX_RESULTS = 5000;

/** Severity as GitHub's alert list understands it, via the `security-severity` property. */
const SECURITY_SEVERITY: Readonly<Record<StoredSeverity, string>> = {
  CRITICAL: "9.5",
  HIGH: "8.0",
  MEDIUM: "5.5",
  LOW: "3.0",
  INFO: "1.0",
};

const LEVEL: Readonly<Record<StoredSeverity, SarifLevel>> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "note",
  INFO: "note",
};

const CATEGORY_DESCRIPTION: Readonly<Record<FindingCategory, string>> = {
  SECRET: "A credential, token or key appears in the source rather than in configuration.",
  VULNERABILITY: "Code that an attacker can use to change behaviour or reach data.",
  MISCONFIG: "A setting that weakens the security posture of the service or its dependencies.",
  OTHER: "A security-relevant finding outside the named categories.",
};

/**
 * Repository-relative POSIX path, which is the only thing GitHub can match
 * against the commit's tree. A Windows runner produces backslashes and some
 * scanners prefix `./`; both make GitHub drop the location silently.
 */
function normalizeUri(fileLocation: string | null | undefined): string {
  if (!fileLocation) return "";

  return fileLocation.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** A positive integer line, or null when the scanner could not place the finding. */
function normalizeLine(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;

  const line = Math.floor(value);
  return line >= 1 ? line : null;
}

function ruleIdFor(category: FindingCategory, severity: StoredSeverity): string {
  return `secureflow/${category.toLowerCase()}/${severity.toLowerCase()}`;
}

/** First non-empty text, so the alert says something useful even without AI enrichment. */
function messageFor(finding: CodeScanningFinding, category: FindingCategory): string {
  const candidates = [finding.explanation, finding.description, finding.remediation];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return `SecureFlow flagged a ${category.toLowerCase()} finding here.`;
}

/**
 * Map server findings onto a SARIF 2.1.0 document.
 *
 * An empty `findings` list is not a reason to skip the upload: a run with no
 * results is how GitHub learns that previously reported alerts are fixed, and
 * skipping it leaves them open forever.
 */
export function buildSarifDocument(findings: readonly CodeScanningFinding[]): SarifDocument {
  const rules: SarifRule[] = [];
  const ruleIndexById = new Map<string, number>();
  const results: SarifResult[] = [];

  // Most severe first, so the cap below drops the least important findings
  // rather than whichever happened to be scanned last.
  const ordered = [...findings].sort(
    (a, b) =>
      storedSeverityRank(toStoredSeverity(a.severity)) -
      storedSeverityRank(toStoredSeverity(b.severity)),
  );

  for (const finding of ordered.slice(0, MAX_RESULTS)) {
    const category = normalizeFindingType(finding.type);
    const severity = toStoredSeverity(finding.severity);
    const id = ruleIdFor(category, severity);

    let ruleIndex = ruleIndexById.get(id);
    if (ruleIndex === undefined) {
      ruleIndex = rules.length;
      ruleIndexById.set(id, ruleIndex);
      rules.push({
        id,
        name: `${category}${severity}`,
        shortDescription: { text: `${severity} ${category.toLowerCase()} finding` },
        fullDescription: { text: CATEGORY_DESCRIPTION[category] },
        defaultConfiguration: { level: LEVEL[severity] },
        properties: {
          tags: ["security", `secureflow:${category.toLowerCase()}`],
          "security-severity": SECURITY_SEVERITY[severity],
        },
        helpUri: INFORMATION_URI,
      });
    }

    const startLine = normalizeLine(finding.lineStart);
    const endLine = normalizeLine(finding.lineEnd);

    results.push({
      ruleId: id,
      ruleIndex,
      level: LEVEL[severity],
      message: { text: messageFor(finding, category) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: normalizeUri(finding.fileLocation) },
            // Omitted rather than faked when the scanner could not place the
            // finding: GitHub rejects a region with no valid startLine, and
            // pointing every unplaced finding at line 1 would be a lie.
            ...(startLine !== null
              ? {
                  region: {
                    startLine,
                    ...(endLine !== null && endLine >= startLine ? { endLine } : {}),
                  },
                }
              : {}),
          },
        },
      ],
      ...(finding.fingerprint
        ? { partialFingerprints: { [FINGERPRINT_KEY]: finding.fingerprint } }
        : {}),
    });
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: TOOL_VERSION,
            informationUri: INFORMATION_URI,
            rules,
          },
        },
        // Keeps this analysis distinct from any other tool's results on the
        // same commit, so uploads do not overwrite each other.
        automationDetails: { id: "secureflow/pull-request-scan" },
        results,
      },
    ],
  };
}

/** gzip, then Base64 — the encoding the endpoint requires. */
export function encodeSarif(document: SarifDocument): string {
  return gzipSync(Buffer.from(JSON.stringify(document), "utf8")).toString("base64");
}

/** 40 hex characters (SHA-1) or 64 (SHA-256), per the endpoint's own pattern. */
export function isValidCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(value);
}

/** `refs/pull/<number>/head` for a pull request scan. */
export function pullRequestRef(pullNumber: number): string {
  return `refs/pull/${pullNumber}/head`;
}

export type SarifUploadOutcome =
  | { status: "uploaded"; id: string | null; url: string | null }
  | { status: "skipped"; reason: SarifSkipReason; statusCode?: number };

export type SarifSkipReason =
  /** Advanced Security is off, the repo is archived, or the App lacks `security_events: write`. */
  | "code-scanning-unavailable"
  /** Too large even after gzip. */
  | "payload-too-large"
  /** GitHub rejected the document, or the call failed for any other reason. */
  | "upload-failed"
  /** Nothing to associate the analysis with. */
  | "invalid-commit-sha";

/** Minimal shape of the installation Octokit this module needs. */
export interface CodeScanningClient {
  request: (route: string, params: Record<string, unknown>) => Promise<{ data?: unknown }>;
}

export interface UploadSarifParams {
  owner: string;
  repo: string;
  commitSha: string;
  ref: string;
  document: SarifDocument;
  /** Repository root on the machine that produced the scan, when it is known. */
  checkoutUri?: string;
}

/**
 * Upload one analysis, and never let the result of that decide whether a scan
 * succeeded.
 *
 * A 403 here is the normal answer for a private repository without Advanced
 * Security, and a 404 is what an installation without the permission sees.
 * Neither says anything about the code that was scanned, so both come back as
 * `skipped` for the caller to log rather than as a thrown error that would fail
 * a pull request check.
 */
export async function uploadSarifAnalysis(
  client: CodeScanningClient,
  params: UploadSarifParams,
): Promise<SarifUploadOutcome> {
  if (!isValidCommitSha(params.commitSha)) {
    return { status: "skipped", reason: "invalid-commit-sha" };
  }

  try {
    const response = await client.request("POST /repos/{owner}/{repo}/code-scanning/sarifs", {
      owner: params.owner,
      repo: params.repo,
      commit_sha: params.commitSha,
      ref: params.ref,
      sarif: encodeSarif(params.document),
      ...(params.checkoutUri ? { checkout_uri: params.checkoutUri } : {}),
    });

    const data = (response?.data ?? {}) as { id?: unknown; url?: unknown };

    return {
      status: "uploaded",
      id: typeof data.id === "string" ? data.id : null,
      url: typeof data.url === "string" ? data.url : null,
    };
  } catch (error) {
    const statusCode = (error as { status?: number })?.status;

    if (statusCode === 403 || statusCode === 404) {
      return { status: "skipped", reason: "code-scanning-unavailable", statusCode };
    }

    if (statusCode === 413) {
      return { status: "skipped", reason: "payload-too-large", statusCode };
    }

    return { status: "skipped", reason: "upload-failed", ...(statusCode ? { statusCode } : {}) };
  }
}
