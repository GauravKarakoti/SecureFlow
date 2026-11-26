/**
 * Real-time Chat Alerting (Slack & Discord) for newly introduced critical findings.
 *
 * Requirements:
 *  - Supports Slack Incoming Webhooks (hooks.slack.com) and Discord Webhooks (discord.com/api/webhooks).
 *  - Validates webhook URLs with strict SSRF protection (no private IPs, loopback, metadata).
 *  - Encrypts webhook URLs at rest with AES-256-GCM.
 *  - URL is never shown in logs or the UI after saving (masked token representation).
 *  - Sends a concise message containing: repository, severity (CRITICAL), count, and dashboard link.
 *  - Never includes code snippets, file contents, or secret values in the message.
 *  - Alerts only on newly introduced critical findings, not ones already reported.
 *  - Exactly one alert per new critical finding (atomic deduplication via Redis / DB check).
 *  - Dispatches with retry and exponential backoff on transient errors (429 rate limit, 5xx).
 *  - Best-effort execution: webhook failures never fail or break the scan.
 */

import crypto from "node:crypto";
import prisma from "@/lib/prisma";
import { redis } from "@/lib/queue/redis";
import {
  dispatchOutboundWebhook,
  resolveDispatchConfig,
  type DispatchConfig,
  type DispatchOptions,
} from "@/lib/queue/outbound-dispatch";

export type ChatProvider = "slack" | "discord";

export interface ChatWebhookValidationResult {
  url: URL;
  provider: ChatProvider;
}

/** Allowed hostname list for Slack and Discord webhooks */
export const ALLOWED_CHAT_HOSTS = new Set([
  "hooks.slack.com",
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

/**
 * Validates that a raw URL is a genuine Slack or Discord Incoming Webhook.
 * Enforces HTTPS, known hostnames, valid paths, no credentials, no custom ports, and no query/fragments.
 */
export function assertChatWebhookUrl(rawUrl: string): ChatWebhookValidationResult {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("Webhook URL is missing.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid webhook URL format.");
  }

  if (url.protocol !== "https:") {
    throw new Error(`Invalid webhook scheme "${url.protocol}" — only https is allowed.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!ALLOWED_CHAT_HOSTS.has(hostname)) {
    throw new Error(
      `Invalid webhook host "${hostname}" — only Slack (hooks.slack.com) or Discord (discord.com) is allowed.`,
    );
  }

  if (url.username || url.password) {
    throw new Error("Webhook URL must not embed credentials.");
  }

  if (url.port && url.port !== "" && url.port !== "443") {
    throw new Error("Webhook URL must not specify a custom port.");
  }

  if (url.search !== "" || url.hash !== "") {
    throw new Error("Webhook URL must not include query parameters or fragments.");
  }

  // Determine provider and check path structure
  if (hostname === "hooks.slack.com") {
    if (!url.pathname.startsWith("/services/")) {
      throw new Error("Slack webhook URL path must start with /services/.");
    }
    return { url, provider: "slack" };
  }

  // Discord hostnames
  if (
    hostname === "discord.com" ||
    hostname === "discordapp.com" ||
    hostname === "ptb.discord.com" ||
    hostname === "canary.discord.com"
  ) {
    if (!/^\/api\/webhooks\/\d+\/[\w-]+$/i.test(url.pathname)) {
      throw new Error(
        "Discord webhook URL path must match /api/webhooks/<webhook_id>/<webhook_token>.",
      );
    }
    return { url, provider: "discord" };
  }

  throw new Error("Unsupported chat webhook provider.");
}

/**
 * Masks a webhook URL to protect secret tokens from leaking into logs or the UI.
 * e.g., https://hooks.slack.com/services/T000/B000/XXXX -> https://hooks.slack.com/services/••••••••
 * e.g., https://discord.com/api/webhooks/12345/abcdef -> https://discord.com/api/webhooks/12345/••••••••
 */
export function maskWebhookUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    return null;
  }

  try {
    const { url, provider } = assertChatWebhookUrl(rawUrl);
    if (provider === "slack") {
      return `${url.origin}/services/••••••••`;
    }
    if (provider === "discord") {
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2] || "";
      return `${url.origin}/api/webhooks/${id}/••••••••`;
    }
    return `${url.origin}/••••••••`;
  } catch {
    // If encrypted or unparseable, return generic masked indicator
    return "••••••••••••••••";
  }
}

// --- Encryption at Rest for Webhook URLs ---

const CIPHER_ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const ENC_PREFIX = "enc:v1:aes-256-gcm:";

function getChatEncryptionKey(): Buffer {
  const secret =
    process.env.ENCRYPTION_KEY ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "secureflow-chat-webhook-secret-key";
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypts a webhook URL at rest with AES-256-GCM.
 */
export function encryptWebhookUrl(plaintext: string): string {
  const key = getChatEncryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypts a stored webhook URL. If plaintext / unencrypted, returns as-is.
 */
export function decryptWebhookUrl(stored: string): string {
  if (!stored || typeof stored !== "string") return "";
  if (!stored.startsWith(ENC_PREFIX)) {
    return stored;
  }

  try {
    const payload = stored.slice(ENC_PREFIX.length);
    const [ivB64, tagB64, cipherB64] = payload.split(":");
    if (!ivB64 || !tagB64 || !cipherB64) return "";

    const key = getChatEncryptionKey();
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ciphertext = Buffer.from(cipherB64, "base64");

    const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return "";
  }
}

// --- Message Payloads (Slack & Discord) ---

export interface BuildChatAlertParams {
  repositoryFullName: string;
  count: number;
  prNumber?: number | null;
  dashboardUrl?: string;
}

/**
 * Constructs a concise chat alert payload.
 * Strictly includes ONLY: repository, severity (CRITICAL), count, and dashboard link.
 * Never includes code snippets or secrets.
 */
export function buildChatAlertPayload(
  provider: ChatProvider,
  { repositoryFullName, count, prNumber, dashboardUrl }: BuildChatAlertParams,
): Record<string, unknown> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://app.secureflow.dev").replace(
    /\/+$/,
    "",
  );
  const targetDashboardUrl = dashboardUrl || `${appUrl}/dashboard`;
  const prLabel = prNumber ? ` #${prNumber}` : "";
  const noun = count === 1 ? "finding" : "findings";

  if (provider === "slack") {
    const headerText = `🚨 SecureFlow: ${count} New CRITICAL ${noun} in ${repositoryFullName}${prLabel}`;
    return {
      text: headerText,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🚨 SecureFlow Security Alert",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Repository:*\n\`${repositoryFullName}\`${prLabel}`,
            },
            {
              type: "mrkdwn",
              text: "*Severity:*\n*CRITICAL*",
            },
            {
              type: "mrkdwn",
              text: `*New Critical Findings:*\n*${count}*`,
            },
            {
              type: "mrkdwn",
              text: `*Dashboard:*\n<${targetDashboardUrl}|View in Dashboard>`,
            },
          ],
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open Dashboard", emoji: true },
              url: targetDashboardUrl,
              style: "danger",
            },
          ],
        },
      ],
    };
  }

  // Discord payload
  const content = `🚨 **SecureFlow Security Alert**\n**Repository:** \`${repositoryFullName}\`${prLabel}\n**Severity:** \`CRITICAL\`\n**New Critical Findings:** **${count}**\n**Dashboard:** ${targetDashboardUrl}`;
  return {
    content,
    embeds: [
      {
        title: "🚨 SecureFlow Critical Security Alert",
        color: 0xe02424, // Red
        url: targetDashboardUrl,
        fields: [
          { name: "Repository", value: `\`${repositoryFullName}\`${prLabel}`, inline: true },
          { name: "Severity", value: "**CRITICAL**", inline: true },
          { name: "New Critical Findings", value: `**${count}**`, inline: true },
        ],
        description: `New critical security findings were detected in \`${repositoryFullName}\`. Review the details on your Mission Control dashboard.\n\n🔗 [Open SecureFlow Dashboard](${targetDashboardUrl})`,
        footer: {
          text: "SecureFlow Digital Heist Defense System",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// --- Outbound Dispatch with Retry & Exponential Backoff ---

export interface SendChatAlertOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  timeoutMs?: number;
  config?: DispatchConfig;
}

/** Sleep helper using Promise */
export const delayMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delivers a chat alert to a Slack or Discord webhook with retry and exponential backoff.
 * Retries on transient errors (429, 5xx, timeouts) up to maxRetries.
 * Never throws, ensuring scan completion is never broken by webhook issues.
 */
export async function sendChatAlert(
  rawUrl: string,
  params: BuildChatAlertParams,
  options: SendChatAlertOptions = {},
): Promise<{ success: boolean; attempts: number; error?: string }> {
  let validated: ChatWebhookValidationResult;
  try {
    validated = assertChatWebhookUrl(rawUrl);
  } catch (err) {
    return {
      success: false,
      attempts: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const { url, provider } = validated;
  const payload = buildChatAlertPayload(provider, params);
  const maxRetries = options.maxRetries ?? 3;
  const initialBackoffMs = options.initialBackoffMs ?? 300;
  const baseConfig = options.config ?? resolveDispatchConfig();

  const config: DispatchConfig = {
    ...baseConfig,
    allowedHosts: [url.hostname],
    allowInsecureHttp: false,
    allowPrivateNetworks: false,
    timeoutMs: options.timeoutMs ?? 5_000,
  };

  let attempts = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    try {
      const res = await dispatchOutboundWebhook(
        {
          url: url.toString(),
          payload,
        },
        { config },
      );

      if (res.status >= 200 && res.status < 300) {
        return { success: true, attempts };
      }

      // Check if retryable (429 rate limit or 5xx server error)
      const isRetryable = res.status === 429 || res.status >= 500;
      lastError = `Chat webhook endpoint responded with HTTP ${res.status}`;

      if (!isRetryable || attempt >= maxRetries) {
        break;
      }

      // Exponential backoff with jitter
      const backoff = initialBackoffMs * Math.pow(2, attempt - 1);
      await delayMs(backoff);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= maxRetries) {
        break;
      }
      const backoff = initialBackoffMs * Math.pow(2, attempt - 1);
      await delayMs(backoff);
    }
  }

  // Safe log without exposing the webhook token
  console.warn(
    `[ChatAlert] Webhook delivery failed after ${attempts} attempts to ${url.hostname}: ${lastError}`,
  );
  return { success: false, attempts, error: lastError };
}

// --- Atomic Alert Deduplication for Newly Introduced Critical Findings ---

export const CRITICAL_ALERT_DEDUPE_TTL = 30 * 86_400; // 30 days
export const CRITICAL_ALERT_PREFIX = "alert:critical:finding:";

/** In-memory fallback set for testing or when Redis is offline */
const inMemoryAlertedFindings = new Set<string>();

export function getCriticalAlertDedupeKey(repositoryId: string, fingerprint: string): string {
  return `${CRITICAL_ALERT_PREFIX}${repositoryId}:${fingerprint}`;
}

export function clearInMemoryAlertedFindings(): void {
  inMemoryAlertedFindings.clear();
}

/**
 * Claims an alert slot for a specific finding.
 * Returns true if this is the first time this finding is alerted (should alert), false if duplicate.
 */
export async function claimCriticalFindingAlert(
  repositoryId: string,
  fingerprint: string,
  redisClient: any = redis,
): Promise<boolean> {
  if (!repositoryId || !fingerprint) return false;

  const key = getCriticalAlertDedupeKey(repositoryId, fingerprint);

  if (redisClient && typeof redisClient.set === "function") {
    try {
      const res = await redisClient.set(key, "1", "EX", CRITICAL_ALERT_DEDUPE_TTL, "NX");
      return res === "OK";
    } catch {
      // Fallback to in-memory set
    }
  }

  if (inMemoryAlertedFindings.has(key)) {
    return false;
  }
  inMemoryAlertedFindings.add(key);
  return true;
}

export interface DispatchCriticalChatAlertParams {
  userId: string | null | undefined;
  repositoryId: string;
  repositoryFullName: string;
  pullRequestId?: string;
  prNumber?: number | null;
  findings: readonly { severity: string; fingerprint?: string | null }[];
  currentScanResultId?: string;
}

/**
 * Orchestrator: Filters for newly introduced critical findings, claims deduplication locks,
 * and sends an alert message to the user's configured Slack or Discord webhook.
 * Never throws, ensuring scan execution is never broken.
 */
export async function dispatchCriticalChatAlert(
  params: DispatchCriticalChatAlertParams,
): Promise<{ alerted: boolean; count: number; error?: string }> {
  try {
    const {
      userId,
      repositoryId,
      repositoryFullName,
      pullRequestId,
      prNumber,
      findings,
      currentScanResultId,
    } = params;

    if (!userId) {
      return { alerted: false, count: 0 };
    }

    // 1. Filter findings to CRITICAL severity with valid fingerprints
    const criticalCandidates = findings.filter(
      (f) =>
        String(f.severity).toUpperCase() === "CRITICAL" &&
        f.fingerprint &&
        f.fingerprint.trim().length > 0,
    );

    if (criticalCandidates.length === 0) {
      return { alerted: false, count: 0 };
    }

    // 2. Fetch user's chat webhook URL (support chatWebhookUrl, falling back to slackWebhookUrl)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        chatWebhookUrl: true,
        slackWebhookUrl: true,
      } as any,
    });

    const encryptedUrl = (user as any)?.chatWebhookUrl || (user as any)?.slackWebhookUrl;
    if (!encryptedUrl || typeof encryptedUrl !== "string" || !encryptedUrl.trim()) {
      return { alerted: false, count: 0 };
    }

    const rawWebhookUrl = decryptWebhookUrl(encryptedUrl.trim());
    if (!rawWebhookUrl) {
      return { alerted: false, count: 0 };
    }

    // 3. Query existing findings in prior scans to exclude already reported findings
    const candidateFingerprints = Array.from(
      new Set(criticalCandidates.map((f) => f.fingerprint!)),
    );

    const whereClause: any = {
      scanResult: {
        repositoryId,
        ...(currentScanResultId ? { id: { not: currentScanResultId } } : {}),
        ...(pullRequestId ? { pullRequestId } : {}),
      },
      severity: "CRITICAL",
      fingerprint: { in: candidateFingerprints },
    };

    const priorFindings = await prisma.finding.findMany({
      where: whereClause,
      select: { fingerprint: true },
    });

    const alreadyReportedFingerprints = new Set(
      priorFindings.map((f: { fingerprint: string | null }) => f.fingerprint),
    );

    // Keep only findings that were NOT reported in any previous scan
    const newlyIntroduced = criticalCandidates.filter(
      (f) => !alreadyReportedFingerprints.has(f.fingerprint!),
    );

    if (newlyIntroduced.length === 0) {
      return { alerted: false, count: 0 };
    }

    // 4. Claim atomic deduplication lock for each new finding
    const unalertedNewFindings: typeof newlyIntroduced = [];
    for (const finding of newlyIntroduced) {
      const isFirstAlert = await claimCriticalFindingAlert(repositoryId, finding.fingerprint!);
      if (isFirstAlert) {
        unalertedNewFindings.push(finding);
      }
    }

    if (unalertedNewFindings.length === 0) {
      return { alerted: false, count: 0 };
    }

    // 5. Send short alert message with repository, severity, count, and dashboard link
    const result = await sendChatAlert(rawWebhookUrl, {
      repositoryFullName,
      count: unalertedNewFindings.length,
      prNumber,
    });

    return {
      alerted: result.success,
      count: unalertedNewFindings.length,
      error: result.error,
    };
  } catch (err) {
    // Fail-safe: Webhook failures must never break the scan
    console.error("[ChatAlert] Unexpected error in dispatchCriticalChatAlert:", err);
    return {
      alerted: false,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
