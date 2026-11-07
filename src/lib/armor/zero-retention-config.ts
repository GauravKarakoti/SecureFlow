/**
 * Enterprise Provider Selection & Zero-Data-Retention API Contracts (#617)
 *
 * Configures enterprise privacy settings for outbound LLM inference endpoints.
 * Supports Zero-Data-Retention (ZDR) request flags, self-hosted local model routing (Ollama/vLLM),
 * and TEE/FHE privacy-preserving execution headers.
 */

export interface LLMProviderSecurityConfig {
  provider: "groq-enterprise" | "local-self-hosted" | "custom-tee-enclave";
  zeroDataRetention: boolean;
  endpointUrl?: string;
  maxRetries?: number;
  enablePrecomputationScrubbing: boolean;
  enableEntropyMasking: boolean;
  enableRegexRedaction: boolean;
  isolateContextHunks: boolean;
}

export const DEFAULT_ENTERPRISE_SECURITY_CONFIG: LLMProviderSecurityConfig = {
  provider: "groq-enterprise",
  zeroDataRetention: true,
  enablePrecomputationScrubbing: true,
  enableEntropyMasking: true,
  enableRegexRedaction: true,
  isolateContextHunks: false,
};

/**
 * Returns customized HTTP headers for enterprise zero-data-retention APIs.
 */
export function getEnterprisePrivacyHeaders(
  config: LLMProviderSecurityConfig = DEFAULT_ENTERPRISE_SECURITY_CONFIG,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (config.zeroDataRetention) {
    headers["X-Enterprise-Zero-Retention"] = "true";
    headers["X-Data-Opt-Out"] = "1";
    headers["X-No-Model-Training"] = "true";
  }

  if (config.provider === "custom-tee-enclave") {
    headers["X-TEE-Attestation-Required"] = "true";
    headers["X-Enclave-Mode"] = "isolated";
  }

  return headers;
}

/**
 * Validates whether an LLM endpoint URL is self-hosted / local to ensure 100% data residency.
 *
 * The hostname is parsed, not substring-matched: substring checks both
 * false-positive on hostile URLs ("https://127.0.0.1.attacker.com",
 * "?next=192.168.1.1") and false-negative on most of the 10.0.0.0/8 range.
 */
export function isLocalEndpoint(url: string): boolean {
  if (!url) return false;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "[::1]"
  ) {
    return true;
  }

  const octets = hostname.split(".");
  if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o))) {
    return false;
  }
  const [a = 0, b = 0] = octets.map(Number);
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8 private
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 0 && b === 0) // 0.0.0.x
  );
}

/**
 * Enterprise Audit logger for egress payload transmission.
 */
export class EgressSecurityAuditor {
  private static auditLogs: Array<{
    timestamp: number;
    provider: string;
    fileCount: number;
    secretsRedactedCount: number;
    zeroRetentionEnforced: boolean;
  }> = [];

  static logEgressTransmission(
    provider: string,
    fileCount: number,
    secretsRedactedCount: number,
    zeroRetentionEnforced: boolean,
  ): void {
    const entry = {
      timestamp: Date.now(),
      provider,
      fileCount,
      secretsRedactedCount,
      zeroRetentionEnforced,
    };
    this.auditLogs.push(entry);
  }

  static getAuditLogs() {
    return [...this.auditLogs];
  }

  static clearAuditLogs() {
    this.auditLogs = [];
  }
}
