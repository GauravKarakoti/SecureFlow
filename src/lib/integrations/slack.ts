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

import {
  SEVERITY_ORDER,
  countBySeverity,
  isAtLeast,
  severityBadge,
  type Severity,
} from "@/lib/severity";
import { maskFindingText } from "@/lib/armor/secret-masking";

/** The severity floor that triggers a Slack alert. */
export const SLACK_ALERT_THRESHOLD: Severity = "HIGH";

/** Longest a single finding summary line may be before it is truncated. */
const MAX_SUMMARY_LENGTH = 300;

/** Cap on how many findings are itemised in the message body. */
const MAX_LISTED_FINDINGS = 10;

/**
 * Slack's own limit on a `section` block's `text.text` (Block Kit reference).
 *
 * Exceeding it is not a truncation — the API answers 400 `invalid_blocks` and
 * drops the whole message, so the alert simply never arrives.
 */
export const SLACK_SECTION_TEXT_LIMIT = 3000;

/** Separator between two itemised findings inside one section. */
const FINDING_SEPARATOR = "\n\n";

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
 * Pack `lines` into as few section bodies as possible, none over the limit.
 *
 * The findings used to be joined into one string and handed to a single
 * section. Ten findings at the 300-character summary cap, with a type and a
 * file path each, comes to roughly 4,000 characters — so the message Slack
 * rejected was the one reporting the most findings, which is exactly the one
 * worth delivering.
 *
 * A line that is over the limit on its own is clipped rather than dropped: it
 * cannot be packed with anything else, and losing the finding entirely is
 * worse than losing its tail.
 */
export function packSectionBodies(
  lines: readonly string[],
  limit: number = SLACK_SECTION_TEXT_LIMIT,
): string[] {
  const bodies: string[] = [];
  let current = "";

  for (const line of lines) {
    const clipped = line.length > limit ? `${line.slice(0, Math.max(0, limit - 1))}…` : line;

    if (!current) {
      current = clipped;
      continue;
    }

    if (current.length + FINDING_SEPARATOR.length + clipped.length <= limit) {
      current += FINDING_SEPARATOR + clipped;
    } else {
      bodies.push(current);
      current = clipped;
    }
  }

  if (current) bodies.push(current);
  return bodies;
}

/**
 * The alert heading, labelled with the severities actually present.
 *
 * It used to use the *threshold's* name for every finding, so a scan with two
 * CRITICALs was announced as "2 high-severity findings": understating exactly
 * the alert that most needs attention.
 */
export function describeFlaggedFindings(flagged: readonly AlertFinding[]): string {
  const counts = countBySeverity(flagged);
  const present = SEVERITY_ORDER.filter((level) => counts[level] > 0);
  const noun = flagged.length === 1 ? "finding" : "findings";

  if (present.length === 1) {
    return `${flagged.length} ${present[0]!.toLowerCase()}-severity ${noun}`;
  }

  const breakdown = present.map((level) => `${counts[level]} ${level.toLowerCase()}`).join(", ");
  return `${flagged.length} ${noun} (${breakdown})`;
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
  const heading = describeFlaggedFindings(flagged);

  const fallback = `🛡️ SecureFlow: ${heading} in ${args.repositoryFullName}#${args.prNumber}`;

  const listed = flagged.slice(0, MAX_LISTED_FINDINGS);
  const findingLines = listed.map(
    (f) =>
      `${severityBadge(f.severity)} *${f.type}* in \`${f.fileLocation}\`\n${summariseFinding(f)}`,
  );

  const overflow = flagged.length - listed.length;
  if (overflow > 0) {
    findingLines.push(`_…and ${overflow} more._`);
  }

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
    // One section per chunk: a body over SLACK_SECTION_TEXT_LIMIT makes Slack
    // reject the entire message, not just that block.
    ...packSectionBodies(findingLines).map((text) => ({
      type: "section",
      text: { type: "mrkdwn", text },
    })),
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
