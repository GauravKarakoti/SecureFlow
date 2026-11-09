/**
 * Thin client for the AI-powered scanning endpoint the SecureFlow GitHub
 * App uses (src/lib/armor/scanner.ts, exposed at POST /api/cli/scan).
 * Gives the CLI parity with the App's AI review, additive on top of the
 * always-available local scan in `scanner.ts`.
 */

import { looksBinary, shouldScanFile } from "../scanner.js";
import {
  cliScanResponseSchema,
  type AiFinding,
  type StagedFileForAiScan,
} from "../contracts/index.js";

export type { StagedFileForAiScan, AiFinding };

export class NetworkUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("SecureFlow API unreachable");
    this.name = "NetworkUnavailableError";
    this.cause = cause;
  }
}

export interface SbomSubmitResponse {
  jobId: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  message?: string;
}

export interface SbomVulnerability {
  id: string;
  pkgName: string;
  installedVersion: string;
  fixedVersion?: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  title?: string;
  description?: string;
}

export interface SbomStatusResponse {
  jobId: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  result?: {
    summary?: {
      totalDependencies: number;
      vulnerableDependencies: number;
      criticalCount: number;
      highCount: number;
      mediumCount: number;
      lowCount: number;
    };
    vulnerabilities?: SbomVulnerability[];
  };
  error?: string;
}

export interface Web3ExplainRequest {
  findingType: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
  fileLocation: string;
  codeSnippet: string;
}

export interface Web3ExplainResponse {
  explanation: string;
  remediationSuggestions: string[];
  ecosystem?: "solidity" | "rust-soroban" | "zk-circuit" | "generic-web3";
}

export interface RemediationPatchResponse {
  success: boolean;
  patch?: {
    id: string;
    findingId: string;
    patchDiff: string;
    status: string;
  };
  explanation?: string;
  error?: string;
  code?: string | undefined;
  retryable?: boolean | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_BASE_URL = "https://secure-flow-six.vercel.app";

/**
 * Request AI remediation patch generation for a specific finding via POST /api/findings/[id]/remediate.
 */
export async function generateRemediationPatch(
  findingId: string,
  options?: {
    baseUrl?: string;
    authToken?: string;
    timeoutMs?: number;
  },
): Promise<RemediationPatchResponse> {
  const normalizedId = findingId.trim();
  if (!normalizedId) {
    throw new Error("findingId must be a non-empty string");
  }

  const baseUrl = options?.baseUrl || DEFAULT_BASE_URL;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options?.authToken) {
      headers["Authorization"] = `Bearer ${options.authToken}`;
    }

    const res = await fetch(
      `${baseUrl}/api/findings/${encodeURIComponent(normalizedId)}/remediate`,
      {
        method: "POST",
        headers,
        signal: controller.signal,
      },
    );

    const data: unknown = await res.json().catch(() => null);

    if (!res.ok) {
      const errPayload = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
      const errorMessage =
        typeof errPayload.message === "string"
          ? errPayload.message
          : typeof errPayload.error === "string"
            ? errPayload.error
            : `SecureFlow Remediation API returned HTTP ${res.status}`;
      const code = typeof errPayload.code === "string" ? errPayload.code : undefined;
      const retryable =
        typeof errPayload.retryable === "boolean"
          ? errPayload.retryable
          : res.status === 429 || res.status >= 500;

      return {
        success: false,
        error: errorMessage,
        code,
        retryable,
      };
    }

    return (data as RemediationPatchResponse) || { success: true };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Remediation request timed out after ${timeoutMs}ms`);
    }
    throw new NetworkUnavailableError(err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Submit an SBOM manifest file to POST /api/sbom/scan.
 */
export async function submitSbomScan(
  fileName: string,
  content: string,
  baseUrl: string = DEFAULT_BASE_URL,
  authToken?: string,
): Promise<SbomSubmitResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const res = await fetch(`${baseUrl}/api/sbom/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fileName, content }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SecureFlow SBOM API responded with ${res.status}`);
    }

    return (await res.json()) as SbomSubmitResponse;
  } catch (err) {
    throw new NetworkUnavailableError(err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Poll SBOM scan job status at GET /api/sbom/scan/status/[jobId].
 */
export async function pollSbomScanStatus(
  jobId: string,
  baseUrl: string = DEFAULT_BASE_URL,
  authToken?: string,
): Promise<SbomStatusResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const res = await fetch(`${baseUrl}/api/sbom/scan/status/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SecureFlow SBOM status API responded with ${res.status}`);
    }

    return (await res.json()) as SbomStatusResponse;
  } catch (err) {
    throw new NetworkUnavailableError(err);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Request Web3 / Smart Contract security explanation.
 */
export async function requestWeb3Explanation(
  request: Web3ExplainRequest,
  baseUrl: string = DEFAULT_BASE_URL,
  authToken?: string,
): Promise<Web3ExplainResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const res = await fetch(`${baseUrl}/api/explain/web3`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Local fallback explanation if endpoint isn't deployed on target host
      return generateLocalWeb3Explanation(request);
    }

    return (await res.json()) as Web3ExplainResponse;
  } catch {
    // Graceful offline fallback
    return generateLocalWeb3Explanation(request);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback Web3 explanation generator when offline or API is unavailable.
 */
export function generateLocalWeb3Explanation(request: Web3ExplainRequest): Web3ExplainResponse {
  const isSolidity =
    request.fileLocation.endsWith(".sol") ||
    request.findingType.toLowerCase().includes("reentrancy");
  const isRust =
    request.fileLocation.endsWith(".rs") ||
    request.findingType.toLowerCase().includes("soroban") ||
    request.findingType.toLowerCase().includes("solana");
  const isZk =
    request.fileLocation.endsWith(".circom") ||
    request.fileLocation.endsWith(".leo") ||
    request.findingType.toLowerCase().includes("zk");

  const ecosystem = isSolidity
    ? "solidity"
    : isRust
      ? "rust-soroban"
      : isZk
        ? "zk-circuit"
        : "generic-web3";

  return {
    ecosystem,
    explanation: `[SecureFlow Web3] Detected potential ${request.severity} vulnerability (${request.findingType}) in ${request.fileLocation}. Ensure state changes precede external calls and access controls are strictly validated.`,
    remediationSuggestions: [
      "Follow Checks-Effects-Interactions (CEI) pattern to prevent reentrancy.",
      "Employ OpenZeppelin or equivalent audited contracts for access control and math validation.",
      "Ensure all circuit signals are strictly constrained with proper range checks.",
    ],
  };
}

/**
 * Whether a staged file may be uploaded to the hosted AI scanner.
 *
 * The same test the local scan applies before it reads a file: lockfiles,
 * binary extensions, NUL-containing content and blobs over
 * `MAX_SCANNED_BYTES` are skipped locally, and there is no reason to send
 * them off the machine either. Without this every readable staged path was
 * uploaded in full, whatever its type or size.
 */
export function isEligibleForAiScan(file: StagedFileForAiScan): boolean {
  return (
    shouldScanFile(file.path, Buffer.byteLength(file.content, "utf-8")) &&
    !looksBinary(file.content)
  );
}

/**
 * Sends staged file contents to the hosted AI scanner. Fails fast (short
 * timeout) and always throws `NetworkUnavailableError` on any failure so
 * callers can swallow it and fall back to the local-only scan -- never
 * block a commit on connectivity.
 */
export async function requestAiFileScan(
  files: StagedFileForAiScan[],
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<AiFinding[]> {
  const eligible = files.filter(isEligibleForAiScan);
  if (eligible.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/cli/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: eligible }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`SecureFlow API responded with ${res.status}`);
    }

    const rawData: unknown = await res.json();
    const parsed = cliScanResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      return Array.isArray((rawData as { findings?: unknown })?.findings)
        ? (rawData as { findings: AiFinding[] }).findings
        : [];
    }
    return parsed.data.findings;
  } catch (err) {
    throw new NetworkUnavailableError(err);
  } finally {
    clearTimeout(timeout);
  }
}
