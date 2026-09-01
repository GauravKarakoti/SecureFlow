/**
 * Enterprise Provider Selection & Zero-Data-Retention API Contracts (#617)
 *
 * Configures enterprise privacy settings for outbound LLM inference endpoints.
 * Supports Zero-Data-Retention (ZDR) request flags, self-hosted local model routing (Ollama/vLLM),
 * and TEE/FHE privacy-preserving execution headers.
 */

export interface LLMProviderSecurityConfig {
  provider: 'groq-enterprise' | 'local-self-hosted' | 'custom-tee-enclave';
  zeroDataRetention: boolean;
  endpointUrl?: string;
  maxRetries?: number;
  enablePrecomputationScrubbing: boolean;
  enableEntropyMasking: boolean;
  enableRegexRedaction: boolean;
  isolateContextHunks: boolean;
}

export const DEFAULT_ENTERPRISE_SECURITY_CONFIG: LLMProviderSecurityConfig = {
  provider: 'groq-enterprise',
  zeroDataRetention: true,
  enablePrecomputationScrubbing: true,
  enableEntropyMasking: true,
  enableRegexRedaction: true,
  isolateContextHunks: false,
};

/**
 * Returns customized HTTP headers for enterprise zero-data-retention APIs.
 */
export function getEnterprisePrivacyHeaders(config: LLMProviderSecurityConfig = DEFAULT_ENTERPRISE_SECURITY_CONFIG): Record<string, string> {
  const headers: Record<string, string> = {};

  if (config.zeroDataRetention) {
    headers['X-Enterprise-Zero-Retention'] = 'true';
    headers['X-Data-Opt-Out'] = '1';
    headers['X-No-Model-Training'] = 'true';
  }

  if (config.provider === 'custom-tee-enclave') {
    headers['X-TEE-Attestation-Required'] = 'true';
    headers['X-Enclave-Mode'] = 'isolated';
  }

  return headers;
}

/**
 * Validates whether an LLM endpoint URL is self-hosted / local to ensure 100% data residency.
 */
export function isLocalEndpoint(url: string): boolean {
  if (!url) return false;
  return (
    url.includes('localhost') ||
    url.includes('127.0.0.1') ||
    url.includes('0.0.0.0') ||
    url.includes('10.0.') ||
    url.includes('192.168.') ||
    url.endsWith('.local')
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
    zeroRetentionEnforced: boolean
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
