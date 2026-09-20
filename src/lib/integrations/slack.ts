/**
 * Slack alerting for high-severity findings (#936).
 *
 * When a scan yields a CRITICAL or HIGH finding, a formatted Block Kit message
 * is posted to the user's configured Incoming Webhook so security teams see it
 * in Slack rather than only as a GitHub PR comment.
 *
 * The two halves are split deliberately:
 *
 *  - Everything that decides the *shape* of the message — which findings clear
 *    the threshold, how the summary reads, the PR URL — is pure and lives in
 *    `buildSlackAlert`, so it is unit-testable without a network or a database.
 *  - `sendSlackAlert` does the one impure thing: a single `fetch` POST.
 *
 * `notifyHighSeverityFindings` is the orchestrator the scan engine calls. It is
 * fire-and-forget by contract: it resolves rather than rejects on any failure,
 * because a Slack outage must never fail a scan whose results are already
 * persisted (the plan's "handle asynchronously to prevent blocking" note).
 */

import { isAtLeast, severityBadge, type Severity } from "@/lib/severity";
import { maskFindingText } from "@/lib/armor/secret-masking";

/** The severity floor that triggers a Slack alert. */
export const SLACK_ALERT_THRESHOLD: Severity = "HIGH";

/** Longest a single finding summary line may be before it is truncated. */
const MAX_SUMMARY_LENGTH = 300;

/** Cap on how many findings are itemised in the message body. */
const MAX_LISTED_FINDINGS = 10;

/** The minimal finding shape the alert needs. */
export interface AlertFinding {
  type: string;
  severity: Severity;
  fileLocation: string;
  /** Human-readable summary; the masked explanation is preferred over the raw description. */
  description?: string | null;
  explanation?: string | null;
}

export interface BuildSlackAlertArgs {
  /** `owner/repo`, as GitHub reports it. */
  repositoryFullName: string;
  /** The pull request number the scan ran against. */
  prNumber: number;
  /** All findings from the scan; filtered to the alert threshold here. */
  findings: readonly AlertFinding[];
  /** Optional minimum severity threshold for triggering an alert (default: SLACK_ALERT_THRESHOLD). */
  minSeverity?: Severity;
}

/** A Slack Incoming Webhook message payload (Block Kit). */
export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

/**
 * Keep only findings at or above the alert threshold, most severe first.
 *
 * `isAtLeast` is the same predicate the policy engine uses, so "high severity"
 * means one thing across the app rather than being re-spelled here.
 */
export function findingsAboveThreshold(
  findings: readonly AlertFinding[],
  threshold: Severity = SLACK_ALERT_THRESHOLD,
): AlertFinding[] {
  return findings.filter((f) => isAtLeast(f.severity, threshold));
}

/** The canonical GitHub URL for a pull request. */
export function pullRequestUrl(repositoryFullName: string, prNumber: number): string {
  return `https://github.com/${repositoryFullName}/pull/${prNumber}`;
}

/**
 * One masked, length-bounded summary line for a finding.
 *
 * The masked explanation is used when the enrichment step produced one; the raw
 * `description` is masked before display because it can quote the offending
 * secret verbatim — the whole reason the GitHub comment path masks too.
 */
function summariseFinding(finding: AlertFinding): string {
  const raw = finding.explanation || finding.description || "";
  const masked = maskFindingText(raw).replace(/\s+/g, " ").trim();
  const clipped =
    masked.length > MAX_SUMMARY_LENGTH ? `${masked.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : masked;
  return clipped || "No description provided.";
}

/**
 * Build the Slack message for a scan's high-severity findings, or `null` when
 * none clear the threshold (so the caller sends nothing rather than an empty
 * alert).
 */
export function buildSlackAlert(args: BuildSlackAlertArgs): SlackMessage | null {
  const threshold = args.minSeverity ?? SLACK_ALERT_THRESHOLD;
  const flagged = findingsAboveThreshold(args.findings, threshold);
  if (flagged.length === 0) return null;

  const url = pullRequestUrl(args.repositoryFullName, args.prNumber);
  const severityLabel = threshold.toLowerCase();
  const heading =
    flagged.length === 1
      ? `1 ${severityLabel}-severity finding`
      : `${flagged.length} ${severityLabel}-severity findings`;

  const fallback = `🛡️ SecureFlow: ${heading} in ${args.repositoryFullName}#${args.prNumber}`;

  const listed = flagged.slice(0, MAX_LISTED_FINDINGS);
  const findingLines = listed
    .map(
      (f) =>
        `${severityBadge(f.severity)} *${f.type}* in \`${f.fileLocation}\`\n${summariseFinding(f)}`,
    )
    .join("\n\n");

  const overflow = flagged.length - listed.length;
  const overflowNote = overflow > 0 ? `\n\n_…and ${overflow} more._` : "";

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🛡️ SecureFlow Security Alert",
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${heading}* detected in <${url}|${args.repositoryFullName}#${args.prNumber}>`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${findingLines}${overflowNote}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Pull Request", emoji: true },
          url,
        },
      ],
    },
  ];

  return { text: fallback, blocks };
}

/**
 * POST a message to a Slack Incoming Webhook.
 *
 * Returns `true` on a 2xx and `false` otherwise; it never throws, so callers can
 * treat notification as best-effort. A 10-second timeout keeps a hung Slack
 * endpoint from holding a worker open indefinitely.
 */
export async function sendSlackAlert(webhookUrl: string, message: SlackMessage): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error(`[Slack] Webhook responded ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Slack] Failed to deliver alert:", err);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a high-severity alert to a webhook URL if one is configured and any
 * finding clears the threshold. Best-effort: resolves to `false` when nothing
 * was sent, and never rejects.
 */
export async function notifyHighSeverityFindings(
  webhookUrl: string | null | undefined,
  args: BuildSlackAlertArgs,
  minSeverity?: Severity,
): Promise<boolean> {
  if (!webhookUrl || !webhookUrl.trim()) return false;

  const alertArgs = minSeverity !== undefined ? { ...args, minSeverity } : args;
  const message = buildSlackAlert(alertArgs);
  if (!message) return false;

  return sendSlackAlert(webhookUrl.trim(), message);
}
