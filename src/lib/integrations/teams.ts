/**
 * Microsoft Teams alerting for BLOCKED scans.
 *
 * When a scan ends as BLOCKED (critical / blocking findings detected),
 * a formatted MessageCard / Adaptive Card message is posted to the user's
 * configured Teams Incoming Webhook URL.
 *
 * Security & Integrity Guarantees:
 *  - Never includes raw code snippets or secret values.
 *  - Only includes repo name, PR link, severity counts, and dashboard link.
 *  - SSRF protected via hardened dispatchOutboundWebhook (allowed host validation,
 *    no private IPs, no credentials, HTTPS only).
 *  - Timeouts and fire-and-forget: failure never throws or fails a scan.
 */

import { countBySeverity, SEVERITY_ORDER, type Severity } from "@/lib/severity";
import {
  dispatchOutboundWebhook,
  resolveDispatchConfig,
  type DispatchConfig,
  type DispatchOptions,
} from "@/lib/queue/outbound-dispatch";

export interface TeamsFindingSummary {
  severity: Severity;
  type?: string;
}

export interface BuildTeamsAlertArgs {
  repositoryFullName: string;
  prNumber: number;
  findings: readonly TeamsFindingSummary[];
  dashboardUrl?: string;
}

/** Legacy / standard Office 365 Connector card format for Microsoft Teams. */
export interface TeamsMessageCard {
  "@type": "MessageCard";
  "@context": "https://schema.org/extensions";
  themeColor: string;
  summary: string;
  title: string;
  sections: Array<{
    activityTitle?: string;
    activitySubtitle?: string;
    facts?: Array<{ name: string; value: string }>;
    markdown?: boolean;
    text?: string;
  }>;
  potentialAction?: Array<{
    "@type": "OpenUri";
    name: string;
    targets: Array<{ os: "default"; uri: string }>;
  }>;
}

/** Allowed Microsoft Teams incoming webhook domains. */
export const ALLOWED_TEAMS_HOST_SUFFIXES = [
  "webhook.office.com",
  "office.com",
  "microsoft.com",
  "logic.azure.com",
];

/**
 * Validate that a URL is a genuine Microsoft Teams Incoming Webhook or Power Automate / Logic Apps URL.
 */
export function assertTeamsWebhookUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("Teams webhook URL is missing.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Invalid Teams webhook URL format.");
  }

  if (url.protocol !== "https:") {
    throw new Error(`Invalid Teams webhook scheme "${url.protocol}" — only https is allowed.`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isAllowedHost = ALLOWED_TEAMS_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );

  if (!isAllowedHost) {
    throw new Error(
      `Invalid Teams webhook host "${hostname}" — only official Microsoft Teams/Office/Azure domains are allowed.`,
    );
  }

  if (url.username || url.password) {
    throw new Error("Teams webhook URL must not embed credentials.");
  }

  if (url.port && url.port !== "" && url.port !== "443") {
    throw new Error("Teams webhook URL must not specify a custom port.");
  }

  return url;
}

/**
 * Build a sanitized summary description without code snippets or secret tokens.
 */
export function buildTeamsAlert(args: BuildTeamsAlertArgs): TeamsMessageCard {
  const counts = countBySeverity(args.findings);
  const prUrl = `https://github.com/${args.repositoryFullName}/pull/${args.prNumber}`;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const dashboardUrl = args.dashboardUrl || `${appUrl}/dashboard`;

  const facts: Array<{ name: string; value: string }> = [
    { name: "Repository", value: args.repositoryFullName },
    { name: "Pull Request", value: `#${args.prNumber}` },
  ];

  for (const level of SEVERITY_ORDER) {
    if (counts[level] > 0) {
      facts.push({ name: `${level} Findings`, value: String(counts[level]) });
    }
  }

  const potentialActions: Array<{
    "@type": "OpenUri";
    name: string;
    targets: Array<{ os: "default"; uri: string }>;
  }> = [
    {
      "@type": "OpenUri",
      name: "View Pull Request",
      targets: [{ os: "default", uri: prUrl }],
    },
    {
      "@type": "OpenUri",
      name: "View Dashboard",
      targets: [{ os: "default", uri: dashboardUrl }],
    },
  ];

  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: "D9383A", // Red accent for BLOCKED scans
    summary: `🛡️ SecureFlow: Scan BLOCKED for ${args.repositoryFullName}#${args.prNumber}`,
    title: `🛡️ SecureFlow Security Scan BLOCKED`,
    sections: [
      {
        activityTitle: `Security Gate Failed`,
        activitySubtitle: `${args.repositoryFullName}#${args.prNumber}`,
        text: `Critical security findings were detected. The pull request has been blocked by policy.`,
        facts,
        markdown: true,
      },
    ],
    potentialAction: potentialActions,
  };
}

/**
 * Send an alert to Microsoft Teams using dispatchOutboundWebhook.
 */
export async function sendTeamsAlert(
  webhookUrl: string,
  message: TeamsMessageCard,
  options: Partial<DispatchOptions> = {},
): Promise<boolean> {
  try {
    const validatedUrl = assertTeamsWebhookUrl(webhookUrl);

    const baseConfig = options.config ?? resolveDispatchConfig();
    const config: DispatchConfig = {
      ...baseConfig,
      allowInsecureHttp: false,
      allowPrivateNetworks: false,
    };

    const res = await dispatchOutboundWebhook(
      {
        url: validatedUrl.toString(),
        payload: message as unknown as Record<string, unknown>,
      },
      {
        ...options,
        config,
      },
    );

    return res.status >= 200 && res.status < 300;
  } catch (err) {
    const messageStr = err instanceof Error ? err.message : String(err);
    console.error("[Teams] Failed to deliver alert:", messageStr);
    return false;
  }
}
