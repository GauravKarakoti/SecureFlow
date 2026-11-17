export interface DigestRepoMetric {
  repositoryId: string;
  name: string;
  openCount: number;
}

export interface DigestFindingTypeMetric {
  type: string;
  count: number;
}

export interface SecurityDigestData {
  id?: string;
  startDate: Date | string;
  endDate: Date | string;
  newFindingsCount: number;
  dismissedFindingsCount: number;
  resolvedFindingsCount: number;
  blockedPrsCount: number;
  topRepositories: DigestRepoMetric[];
  topFindingTypes: DigestFindingTypeMetric[];
}

export interface DigestUser {
  name?: string | null;
  email?: string | null;
  codename?: string | null;
}

/**
 * Format a Date object into human-readable string (YYYY-MM-DD).
 */
function formatDate(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 10);
}

/**
 * Render Plain Text email representation of the Weekly Security Digest (#1788).
 * Ensures zero code snippets or secret tokens are leaked.
 */
export function renderDigestText(
  digest: SecurityDigestData,
  user: DigestUser,
  appUrl: string = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:9002",
): string {
  const recipientName = user.name
    ? user.codename
      ? `${user.name} (${user.codename})`
      : user.name
    : user.codename || "Operator";
  const startStr = formatDate(digest.startDate);
  const endStr = formatDate(digest.endDate);

  const lines: string[] = [
    `SECUREFLOW WEEKLY SECURITY DIGEST`,
    `================================`,
    `Period: ${startStr} to ${endStr}`,
    `Recipient: ${recipientName}`,
    ``,
    `EXECUTIVE SUMMARY`,
    `-----------------`,
    `- New Findings Detected:       ${digest.newFindingsCount}`,
    `- Findings Resolved:           ${digest.resolvedFindingsCount}`,
    `- Findings Dismissed:          ${digest.dismissedFindingsCount}`,
    `- Blocked Pull Requests:       ${digest.blockedPrsCount}`,
    ``,
    `TOP REPOSITORIES BY OPEN FINDINGS`,
    `---------------------------------`,
  ];

  if (digest.topRepositories.length === 0) {
    lines.push(`No repositories with open security findings.`);
  } else {
    digest.topRepositories.slice(0, 5).forEach((repo, i) => {
      lines.push(`${i + 1}. ${repo.name}: ${repo.openCount} open finding(s)`);
    });
  }

  lines.push(``, `TOP RECURRING FINDING TYPES`, `---------------------------`);

  if (digest.topFindingTypes.length === 0) {
    lines.push(`No findings recorded in this period.`);
  } else {
    digest.topFindingTypes.slice(0, 5).forEach((item, i) => {
      lines.push(`${i + 1}. ${item.type}: ${item.count} occurrence(s)`);
    });
  }

  lines.push(
    ``,
    `View your detailed findings and past digests online:`,
    `${appUrl}/dashboard/digest`,
    ``,
    `Manage digest settings:`,
    `${appUrl}/dashboard/settings`,
    ``,
    `---`,
    `SecureFlow Continuous Security Analysis Engine`,
  );

  return lines.join("\n");
}

/**
 * Render HTML email representation of the Weekly Security Digest (#1788).
 * Never contains code snippets or secret tokens.
 */
export function renderDigestHtml(
  digest: SecurityDigestData,
  user: DigestUser,
  appUrl: string = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:9002",
): string {
  const recipientName = user.name
    ? user.codename
      ? `${user.name} (${user.codename})`
      : user.name
    : user.codename || "Operator";
  const startStr = formatDate(digest.startDate);
  const endStr = formatDate(digest.endDate);

  const repoRows =
    digest.topRepositories.length === 0
      ? `<tr><td colspan="2" style="padding: 12px; text-align: center; color: #888888;">No repositories with open security findings.</td></tr>`
      : digest.topRepositories
          .slice(0, 5)
          .map(
            (repo, i) => `
        <tr style="border-bottom: 1px solid #222222;">
          <td style="padding: 10px 12px; color: #e0e0e0; font-family: monospace;">${i + 1}. ${escapeHtml(repo.name)}</td>
          <td style="padding: 10px 12px; text-align: right; color: #f87171; font-weight: bold;">${repo.openCount}</td>
        </tr>`,
          )
          .join("");

  const typeRows =
    digest.topFindingTypes.length === 0
      ? `<tr><td colspan="2" style="padding: 12px; text-align: center; color: #888888;">No findings recorded in this period.</td></tr>`
      : digest.topFindingTypes
          .slice(0, 5)
          .map(
            (item, i) => `
        <tr style="border-bottom: 1px solid #222222;">
          <td style="padding: 10px 12px; color: #e0e0e0; font-family: monospace;">${i + 1}. ${escapeHtml(item.type)}</td>
          <td style="padding: 10px 12px; text-align: right; color: #60a5fa; font-weight: bold;">${item.count}</td>
        </tr>`,
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureFlow Weekly Security Digest</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0c0d0e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e5e7eb;">
  <div style="max-width: 640px; margin: 0 auto; padding: 24px 16px;">
    <!-- Header -->
    <div style="padding: 24px; background: linear-gradient(135deg, #111827 0%, #1f2937 100%); border-radius: 8px 8px 0 0; border: 1px solid #374151; border-bottom: none;">
      <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #3b82f6; letter-spacing: 1px; text-transform: uppercase;">
        🛡️ SecureFlow Security Digest
      </h1>
      <p style="margin: 8px 0 0 0; font-size: 13px; color: #9ca3af;">
        Weekly report for <strong>${escapeHtml(recipientName)}</strong> &bull; ${startStr} &mdash; ${endStr}
      </p>
    </div>

    <!-- Main Container -->
    <div style="background-color: #111827; padding: 24px; border: 1px solid #374151; border-top: none; border-bottom: none;">
      <!-- Metrics Grid -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom: 24px;">
        <tr>
          <td width="25%" style="padding: 8px;">
            <div style="background-color: #1f2937; border-radius: 6px; padding: 12px; text-align: center; border: 1px solid #374151;">
              <div style="font-size: 24px; font-weight: bold; color: #f87171;">${digest.newFindingsCount}</div>
              <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; margin-top: 4px;">New Findings</div>
            </div>
          </td>
          <td width="25%" style="padding: 8px;">
            <div style="background-color: #1f2937; border-radius: 6px; padding: 12px; text-align: center; border: 1px solid #374151;">
              <div style="font-size: 24px; font-weight: bold; color: #34d399;">${digest.resolvedFindingsCount}</div>
              <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; margin-top: 4px;">Resolved</div>
            </div>
          </td>
          <td width="25%" style="padding: 8px;">
            <div style="background-color: #1f2937; border-radius: 6px; padding: 12px; text-align: center; border: 1px solid #374151;">
              <div style="font-size: 24px; font-weight: bold; color: #fbbf24;">${digest.dismissedFindingsCount}</div>
              <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; margin-top: 4px;">Dismissed</div>
            </div>
          </td>
          <td width="25%" style="padding: 8px;">
            <div style="background-color: #1f2937; border-radius: 6px; padding: 12px; text-align: center; border: 1px solid #374151;">
              <div style="font-size: 24px; font-weight: bold; color: #ef4444;">${digest.blockedPrsCount}</div>
              <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; margin-top: 4px;">Blocked PRs</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Top Repositories -->
      <div style="margin-bottom: 24px;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px;">
          Top Repositories by Open Findings
        </h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #182234; border-radius: 6px; border: 1px solid #2d3748; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid #374151; background-color: #1f2937;">
              <th align="left" style="padding: 8px 12px; font-size: 12px; color: #9ca3af;">Repository</th>
              <th align="right" style="padding: 8px 12px; font-size: 12px; color: #9ca3af;">Open Count</th>
            </tr>
          </thead>
          <tbody>
            ${repoRows}
          </tbody>
        </table>
      </div>

      <!-- Top Finding Types -->
      <div style="margin-bottom: 24px;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.5px;">
          Top Recurring Finding Types
        </h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #182234; border-radius: 6px; border: 1px solid #2d3748; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid #374151; background-color: #1f2937;">
              <th align="left" style="padding: 8px 12px; font-size: 12px; color: #9ca3af;">Finding Type</th>
              <th align="right" style="padding: 8px 12px; font-size: 12px; color: #9ca3af;">Occurrences</th>
            </tr>
          </thead>
          <tbody>
            ${typeRows}
          </tbody>
        </table>
      </div>

      <!-- CTA -->
      <div style="text-align: center; margin-top: 32px; margin-bottom: 8px;">
        <a href="${appUrl}/dashboard/digest" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px;">
          Open Dashboard Security Digest &rarr;
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #0f172a; padding: 16px 24px; border-radius: 0 0 8px 8px; border: 1px solid #374151; border-top: none; text-align: center; font-size: 12px; color: #6b7280;">
      <p style="margin: 0 0 8px 0;">You received this automated report because Weekly Security Digests are enabled on your account.</p>
      <p style="margin: 0;">To opt out, update your preferences in <a href="${appUrl}/dashboard/settings" style="color: #60a5fa; text-decoration: none;">Dashboard Settings</a>.</p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
