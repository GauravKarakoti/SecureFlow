/**
 * SecureFlow Shareable Security Report Generator
 *
 * Generates an executive, dark-mode friendly security dossier and shareable HTML report
 * with Money Heist-themed terminology ("Heist Risk Score", "Vault Integrity Status")
 * and distinctive styling accented with #5A29E4 (Electric Royal Violet) and #0A5C3E (Deep Vault Emerald).
 */

export interface SeverityDistribution {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ShareableReportFinding {
  id: string;
  severity: string;
  type: string;
  fileLocation: string;
  lineStart?: number | string | null;
  lineEnd?: number | string | null;
  repository?: string;
  pullRequest?: number | string | null;
  status: string;
  remediation?: string | null;
  createdAt?: string | Date;
}

export interface HeistRiskMetrics {
  score: number;
  level: "MINIMAL" | "GUARDED" | "ELEVATED" | "CRITICAL BREACH";
  label: string;
  badge: string;
  color: string;
}

export interface VaultIntegrityMetrics {
  percentage: number;
  status: "FORTIFIED" | "SECURED" | "GUARDED" | "COMPROMISED";
  label: string;
  color: string;
  accentColor: string;
}

export interface ShareableReportOptions {
  title?: string;
  reportId?: string;
  generatedAt?: Date | string;
  filterSummary?: string;
  repositoryName?: string;
  findings: ShareableReportFinding[];
  totalCount?: number;
  distribution?: SeverityDistribution;
  heistRiskScore?: number;
  vaultIntegrity?: number;
}

/**
 * Escapes characters for HTML injection safety.
 */
export function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Calculates the Heist Risk Score (0 - 100) based on finding severity distribution.
 * Critical: 25 pts each
 * High: 10 pts each
 * Medium: 3 pts each
 * Low: 1 pt each
 */
export function calculateHeistRiskScore(
  counts: Partial<SeverityDistribution> = {},
): HeistRiskMetrics {
  const critical = counts.critical || 0;
  const high = counts.high || 0;
  const medium = counts.medium || 0;
  const low = counts.low || 0;

  const rawScore = critical * 25 + high * 10 + medium * 3 + low * 1;
  const score = Math.min(100, Math.max(0, rawScore));

  if (score === 0) {
    return {
      score: 0,
      level: "MINIMAL",
      label: "Minimal Risk",
      badge: "PERIMETER SECURE",
      color: "#10B981",
    };
  }
  if (score < 25) {
    return {
      score,
      level: "MINIMAL",
      label: "Minimal Risk",
      badge: "DEFENSES HOLDING",
      color: "#10B981",
    };
  }
  if (score < 50) {
    return {
      score,
      level: "GUARDED",
      label: "Guarded Risk",
      badge: "MONITORING ACTIVE",
      color: "#3B82F6",
    };
  }
  if (score < 80) {
    return {
      score,
      level: "ELEVATED",
      label: "Elevated Risk",
      badge: "PERIMETER THREAT",
      color: "#F59E0B",
    };
  }
  return {
    score,
    level: "CRITICAL BREACH",
    label: "Critical Breach",
    badge: "VAULT COMPROMISED",
    color: "#EF4444",
  };
}

/**
 * Calculates the Vault Integrity Status based on findings or scan health.
 * 90-100%: FORTIFIED (#0A5C3E accent)
 * 75-89%: SECURED
 * 50-74%: GUARDED
 * < 50%: COMPROMISED
 */
export function calculateVaultIntegrity(
  countsOrRate: Partial<SeverityDistribution> | { passRate?: number },
): VaultIntegrityMetrics {
  let percentage = 100;

  if ("passRate" in countsOrRate && typeof countsOrRate.passRate === "number") {
    percentage = Math.max(0, Math.min(100, Math.round(countsOrRate.passRate)));
  } else {
    const c = countsOrRate as Partial<SeverityDistribution>;
    const penalty = (c.critical || 0) * 20 + (c.high || 0) * 8 + (c.medium || 0) * 2;
    percentage = Math.max(0, Math.min(100, 100 - penalty));
  }

  if (percentage >= 90) {
    return {
      percentage,
      status: "FORTIFIED",
      label: "Vault Fortified",
      color: "#0A5C3E",
      accentColor: "#10B981",
    };
  }
  if (percentage >= 75) {
    return {
      percentage,
      status: "SECURED",
      label: "Vault Secured",
      color: "#0A5C3E",
      accentColor: "#34D399",
    };
  }
  if (percentage >= 50) {
    return {
      percentage,
      status: "GUARDED",
      label: "Vault Guarded",
      color: "#854D0E",
      accentColor: "#FBBF24",
    };
  }
  return {
    percentage,
    status: "COMPROMISED",
    label: "Vault Compromised",
    color: "#7F1D1D",
    accentColor: "#F87171",
  };
}

/**
 * Derives severity distribution from an array of findings.
 */
export function deriveDistribution(findings: ShareableReportFinding[]): SeverityDistribution {
  const dist: SeverityDistribution = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    const s = String(f.severity).toUpperCase();
    if (s === "CRITICAL") dist.critical++;
    else if (s === "HIGH") dist.high++;
    else if (s === "MEDIUM") dist.medium++;
    else if (s === "LOW") dist.low++;
  }
  return dist;
}

/**
 * Returns a Professor-style defensive advice string based on finding type.
 */
function getProfessorDirective(type: string, remediation?: string | null): string {
  if (remediation && remediation.trim().length > 0) {
    return remediation.trim();
  }

  const normalized = type.toUpperCase();
  if (normalized.includes("SECRET") || normalized.includes("KEY") || normalized.includes("TOKEN")) {
    return "Immediately rotate compromised credentials and revoke all active sessions. Invalidate public tokens via provider console and verify secrets are stored exclusively in an HSM or encrypted secrets manager.";
  }
  if (normalized.includes("SQL") || normalized.includes("INJECTION")) {
    return "Sanitize dynamic SQL fragments with parameterized queries. Avoid string interpolation in database calls and enforce strict input type boundaries.";
  }
  if (normalized.includes("XSS") || normalized.includes("SCRIPT")) {
    return "Encode untrusted HTML entities before rendering. Enforce a restrictive Content Security Policy (CSP) and disallow inline script evaluation.";
  }
  if (normalized.includes("AUTH") || normalized.includes("SESSION")) {
    return "Enforce multi-factor verification and cryptographically secure session rotation. Ensure authorization middleware validates RBAC permissions on every route.";
  }
  return "Audit the flagged code path, isolate potential attack vectors, and enforce least-privilege boundary validations across all inputs.";
}

/**
 * Generates a self-contained, dark-mode friendly HTML report formatted with card layouts,
 * themed terminology ("Heist Risk Score", "Vault Integrity Status"), and accents #5A29E4 and #0A5C3E.
 */
export function generateShareableReportHtml(options: ShareableReportOptions): string {
  const now = options.generatedAt
    ? new Date(options.generatedAt)
    : new Date();
  const reportDateStr = now.toUTCString();
  const reportId =
    options.reportId ||
    `SEC-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const findings = options.findings || [];
  const totalCount = options.totalCount ?? findings.length;
  const distribution = options.distribution || deriveDistribution(findings);

  const heistRisk =
    options.heistRiskScore !== undefined
      ? {
          ...calculateHeistRiskScore({ critical: Math.ceil(options.heistRiskScore / 25) }),
          score: options.heistRiskScore,
        }
      : calculateHeistRiskScore(distribution);

  const vaultIntegrity =
    options.vaultIntegrity !== undefined
      ? calculateVaultIntegrity({ passRate: options.vaultIntegrity })
      : calculateVaultIntegrity(distribution);

  const openCount = findings.filter(
    (f) => !f.status || f.status.toUpperCase() === "OPEN",
  ).length;
  const resolvedCount = findings.filter(
    (f) => f.status && f.status.toUpperCase() === "RESOLVED",
  ).length;

  // Build Finding Cards
  const findingCardsHtml =
    findings.length === 0
      ? `
    <div class="empty-state">
      <div class="empty-state-shield">🛡️</div>
      <h3>Vault Perimeter Unbroken</h3>
      <p>No active security vulnerabilities or leaked secrets detected in the current scope.</p>
    </div>`
      : findings
          .map((f, index) => {
            const sev = String(f.severity || "LOW").toUpperCase();
            const sevColorClass =
              sev === "CRITICAL"
                ? "sev-critical"
                : sev === "HIGH"
                  ? "sev-high"
                  : sev === "MEDIUM"
                    ? "sev-medium"
                    : "sev-low";

            const statusUpper = String(f.status || "OPEN").toUpperCase();
            const statusClass =
              statusUpper === "RESOLVED"
                ? "status-resolved"
                : statusUpper === "DISMISSED"
                  ? "status-dismissed"
                  : "status-open";

            const fileLoc = f.fileLocation || "Unknown File";
            const lineInfo =
              f.lineStart !== null && f.lineStart !== undefined && f.lineStart !== ""
                ? `:${f.lineStart}${f.lineEnd ? `-${f.lineEnd}` : ""}`
                : "";

            const repo = f.repository || options.repositoryName || "Unknown Repository";
            const pr =
              f.pullRequest !== null && f.pullRequest !== undefined && f.pullRequest !== ""
                ? `PR #${f.pullRequest}`
                : "Base Branch";

            const directive = getProfessorDirective(f.type, f.remediation);

            return `
      <div class="finding-card ${sevColorClass}-border" data-severity="${sev}" data-status="${statusUpper}">
        <div class="card-header">
          <div class="card-badges">
            <span class="badge ${sevColorClass}">${escapeHtml(sev)}</span>
            <span class="badge badge-type">${escapeHtml(f.type)}</span>
            <span class="badge ${statusClass}">${escapeHtml(statusUpper)}</span>
          </div>
          <span class="finding-index">#${index + 1} &bull; ${escapeHtml(f.id)}</span>
        </div>

        <div class="card-meta">
          <div class="meta-row">
            <span class="meta-label">Location:</span>
            <code class="code-path">${escapeHtml(fileLoc)}${escapeHtml(lineInfo)}</code>
          </div>
          <div class="meta-row">
            <span class="meta-label">Target:</span>
            <span class="meta-value">${escapeHtml(repo)} &bull; <strong>${escapeHtml(pr)}</strong></span>
          </div>
        </div>

        <div class="professor-directive">
          <div class="directive-title">
            <span class="directive-icon">&#9874;</span> The Professor's Strategic Directive
          </div>
          <p class="directive-text">${escapeHtml(directive)}</p>
        </div>
      </div>`;
          })
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureFlow // Security Dossier - ${escapeHtml(reportId)}</title>
  <style>
    :root {
      --bg-dark: #0A0A0F;
      --card-bg: #14141F;
      --card-elevated: #1B1B29;
      --border-color: #27273A;
      --text-main: #F3F4F6;
      --text-muted: #9CA3AF;
      --royal-violet: #5A29E4;
      --vault-emerald: #0A5C3E;
      --vault-emerald-glow: #10B981;
      --sev-critical: #EF4444;
      --sev-high: #F97316;
      --sev-medium: #F59E0B;
      --sev-low: #3B82F6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg-dark);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.5;
      padding: 32px 20px;
    }

    .report-container {
      max-width: 1040px;
      margin: 0 auto;
    }

    /* Header & Branding */
    .report-header {
      border-bottom: 2px solid var(--border-color);
      padding-bottom: 24px;
      margin-bottom: 32px;
      position: relative;
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 12px;
    }
    .brand-title-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-logo {
      background: linear-gradient(135deg, #5A29E4, #7C3AED);
      color: #fff;
      font-weight: 900;
      font-size: 18px;
      padding: 8px 12px;
      border-radius: 8px;
      box-shadow: 0 0 20px rgba(90, 41, 228, 0.45);
      letter-spacing: 1px;
    }
    .report-headline {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(90deg, #FFFFFF, #D1D5DB);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .report-subtitle {
      color: var(--text-muted);
      font-size: 14px;
    }
    .actions-bar {
      display: flex;
      gap: 10px;
    }
    .btn-action {
      background: #5A29E4;
      color: #FFFFFF;
      border: 1px solid rgba(255, 255, 255, 0.15);
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s ease;
      box-shadow: 0 4px 14px rgba(90, 41, 228, 0.35);
    }
    .btn-action:hover {
      background: #4A1FD0;
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(90, 41, 228, 0.5);
    }
    .header-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 16px 24px;
      margin-top: 14px;
      font-size: 12px;
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .header-meta span strong { color: #E5E7EB; }

    /* Themed Summary Metrics Cards */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 16px;
      margin-bottom: 32px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: #5A29E4;
    }
    .metric-card::before {
      content: "";
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
    }
    .metric-card.heist-risk::before {
      background: linear-gradient(90deg, #5A29E4, #7C3AED);
    }
    .metric-card.vault-integrity::before {
      background: linear-gradient(90deg, #0A5C3E, #10B981);
    }
    .metric-card.findings-total::before {
      background: linear-gradient(90deg, #F59E0B, #EF4444);
    }
    .metric-card.defense-posture::before {
      background: linear-gradient(90deg, #3B82F6, #6366F1);
    }
    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 700;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .metric-value {
      font-size: 36px;
      font-weight: 900;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #FFFFFF;
      line-height: 1;
    }
    .metric-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .vault-status-pill {
      display: inline-block;
      padding: 3px 8px;
      background: #0A5C3E;
      color: #E6FBF2;
      border: 1px solid #10B981;
      border-radius: 4px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    .heist-badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: 0.5px;
      background: rgba(90, 41, 228, 0.25);
      color: #C4B5FD;
      border: 1px solid #5A29E4;
    }

    /* Severity Breakdown Bar */
    .severity-bar-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 32px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .severity-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: center;
    }
    .sev-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--card-elevated);
      border: 1px solid var(--border-color);
    }
    .sev-dot {
      width: 8px; height: 8px; border-radius: 50%;
    }
    .dot-critical { background: var(--sev-critical); box-shadow: 0 0 6px var(--sev-critical); }
    .dot-high { background: var(--sev-high); box-shadow: 0 0 6px var(--sev-high); }
    .dot-medium { background: var(--sev-medium); box-shadow: 0 0 6px var(--sev-medium); }
    .dot-low { background: var(--sev-low); box-shadow: 0 0 6px var(--sev-low); }

    /* Findings Cards Section */
    .section-title-group {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: #FFFFFF;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-title::before {
      content: "";
      width: 4px;
      height: 18px;
      background: #5A29E4;
      border-radius: 2px;
      display: inline-block;
    }
    .findings-list {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Single Finding Card */
    .finding-card {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
      transition: all 0.2s ease;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .finding-card:hover {
      border-color: #5A29E4;
      box-shadow: 0 8px 24px rgba(90, 41, 228, 0.15);
    }
    .finding-card.sev-critical-border { border-left: 4px solid var(--sev-critical); }
    .finding-card.sev-high-border { border-left: 4px solid var(--sev-high); }
    .finding-card.sev-medium-border { border-left: 4px solid var(--sev-medium); }
    .finding-card.sev-low-border { border-left: 4px solid var(--sev-low); }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .card-badges {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .badge.sev-critical { background: rgba(239, 68, 68, 0.15); color: #F87171; border: 1px solid rgba(239, 68, 68, 0.4); }
    .badge.sev-high { background: rgba(249, 115, 22, 0.15); color: #FB923C; border: 1px solid rgba(249, 115, 22, 0.4); }
    .badge.sev-medium { background: rgba(245, 158, 11, 0.15); color: #FCD34D; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge.sev-low { background: rgba(59, 130, 246, 0.15); color: #93C5FD; border: 1px solid rgba(59, 130, 246, 0.4); }
    .badge.badge-type { background: rgba(90, 41, 228, 0.15); color: #C4B5FD; border: 1px solid rgba(90, 41, 228, 0.4); }
    .badge.status-open { background: rgba(239, 68, 68, 0.1); color: #FCA5A5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge.status-resolved { background: rgba(16, 185, 129, 0.15); color: #6EE7B7; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge.status-dismissed { background: rgba(156, 163, 175, 0.15); color: #D1D5DB; border: 1px solid rgba(156, 163, 175, 0.4); }

    .finding-index {
      font-size: 11px;
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .card-meta {
      background: var(--card-elevated);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
    }
    .meta-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .meta-label {
      color: var(--text-muted);
      font-weight: 600;
      min-width: 65px;
    }
    .code-path {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #A7F3D0;
      background: rgba(0, 0, 0, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      word-break: break-all;
    }
    .meta-value { color: var(--text-main); }

    /* The Professor's Strategic Directive */
    .professor-directive {
      background: rgba(90, 41, 228, 0.08);
      border: 1px solid rgba(90, 41, 228, 0.3);
      border-left: 4px solid #5A29E4;
      border-radius: 6px;
      padding: 12px 16px;
      margin-top: 10px;
    }
    .directive-title {
      font-size: 12px;
      font-weight: 700;
      color: #C4B5FD;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .directive-icon { color: #A78BFA; }
    .directive-text {
      font-size: 13px;
      color: #E5E7EB;
      line-height: 1.5;
    }

    .empty-state {
      background: var(--card-bg);
      border: 1px dashed var(--border-color);
      border-radius: 12px;
      padding: 60px 20px;
      text-align: center;
    }
    .empty-state-shield { font-size: 48px; margin-bottom: 12px; }
    .empty-state h3 { font-size: 18px; margin-bottom: 8px; color: #FFFFFF; }
    .empty-state p { font-size: 13px; color: var(--text-muted); }

    .report-footer {
      border-top: 1px solid var(--border-color);
      padding-top: 24px;
      margin-top: 48px;
      text-align: center;
      font-size: 11px;
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* Print / PDF Formatting */
    @media print {
      body {
        background: #FFFFFF !important;
        color: #111827 !important;
        padding: 0;
      }
      .no-print { display: none !important; }
      .metric-card, .finding-card, .severity-bar-card {
        background: #FFFFFF !important;
        border: 1px solid #E5E7EB !important;
        color: #111827 !important;
        box-shadow: none !important;
      }
      .metric-value { color: #111827 !important; }
      .report-headline {
        background: none !important;
        -webkit-text-fill-color: #111827 !important;
        color: #111827 !important;
      }
      .card-meta { background: #F9FAFB !important; }
      .code-path { color: #065F46 !important; background: #ECFDF5 !important; }
      .meta-value, .directive-text { color: #1F2937 !important; }
      .professor-directive {
        background: #F5F3FF !important;
        border: 1px solid #DDD6FE !important;
        border-left: 4px solid #5A29E4 !important;
      }
      .directive-title { color: #5A29E4 !important; }
      .finding-card { page-break-inside: avoid; break-inside: avoid; margin-bottom: 12px; }
    }
  </style>
</head>
<body>
  <div class="report-container">
    <!-- Header -->
    <header class="report-header">
      <div class="header-top">
        <div class="brand-title-group">
          <div class="brand-logo">SECUREFLOW</div>
          <div>
            <h1 class="report-headline">Security Dossier &amp; Vulnerability Audit</h1>
            <p class="report-subtitle">The Professor's Mission Control &bull; Tactical Defense Report</p>
          </div>
        </div>
        <div class="actions-bar no-print">
          <button class="btn-action" onclick="window.print()">
            <span>&#128438;</span> Print / Save PDF
          </button>
        </div>
      </div>

      <div class="header-meta">
        <span>REPORT ID: <strong>${escapeHtml(reportId)}</strong></span>
        <span>GENERATED: <strong>${escapeHtml(reportDateStr)}</strong></span>
        ${
          options.filterSummary
            ? `<span>FILTER: <strong>${escapeHtml(options.filterSummary)}</strong></span>`
            : ""
        }
        <span>STATUS: <strong>VERIFIED</strong></span>
      </div>
    </header>

    <!-- Themed Summary Metrics Cards -->
    <section class="metrics-grid">
      <!-- Heist Risk Score -->
      <div class="metric-card heist-risk">
        <div class="metric-label">Heist Risk Score</div>
        <div class="metric-value-row">
          <div class="metric-value" style="color: ${heistRisk.color};">${heistRisk.score}</div>
          <span style="font-size: 16px; color: var(--text-muted); font-family: monospace;">/100</span>
        </div>
        <div class="metric-sub">
          <span class="heist-badge">${escapeHtml(heistRisk.badge)}</span>
        </div>
      </div>

      <!-- Vault Integrity Status -->
      <div class="metric-card vault-integrity">
        <div class="metric-label">Vault Integrity Status</div>
        <div class="metric-value-row">
          <div class="metric-value" style="color: ${vaultIntegrity.accentColor};">${vaultIntegrity.percentage}%</div>
        </div>
        <div class="metric-sub">
          <span class="vault-status-pill">${escapeHtml(vaultIntegrity.status)}</span>
        </div>
      </div>

      <!-- Total Findings -->
      <div class="metric-card findings-total">
        <div class="metric-label">Total Findings</div>
        <div class="metric-value-row">
          <div class="metric-value">${totalCount}</div>
        </div>
        <div class="metric-sub">
          <span>${openCount} Active &bull; ${resolvedCount} Resolved</span>
        </div>
      </div>

      <!-- Defense Posture -->
      <div class="metric-card defense-posture">
        <div class="metric-label">Defense Posture</div>
        <div class="metric-value-row">
          <div class="metric-value" style="color: #60A5FA;">${distribution.critical}</div>
          <span style="font-size: 14px; color: var(--text-muted); font-weight: 600;">Critical</span>
        </div>
        <div class="metric-sub">
          <span>${distribution.high} High &bull; ${distribution.medium} Medium &bull; ${distribution.low} Low</span>
        </div>
      </div>
    </section>

    <!-- Severity Counts Bar -->
    <div class="severity-bar-card">
      <span style="font-size: 13px; font-weight: 700; color: #FFFFFF;">SEVERITY DISTRIBUTION:</span>
      <div class="severity-counts">
        <div class="sev-pill">
          <span class="sev-dot dot-critical"></span>
          <span>${distribution.critical} Critical</span>
        </div>
        <div class="sev-pill">
          <span class="sev-dot dot-high"></span>
          <span>${distribution.high} High</span>
        </div>
        <div class="sev-pill">
          <span class="sev-dot dot-medium"></span>
          <span>${distribution.medium} Medium</span>
        </div>
        <div class="sev-pill">
          <span class="sev-dot dot-low"></span>
          <span>${distribution.low} Low</span>
        </div>
      </div>
    </div>

    <!-- Findings Section -->
    <section class="findings-section">
      <div class="section-title-group">
        <h2 class="section-title">Security Findings &amp; Tactical Breakdown</h2>
        <span style="font-size: 12px; color: var(--text-muted); font-mono;">Showing ${findings.length} of ${totalCount}</span>
      </div>

      <div class="findings-list">
        ${findingCardsHtml}
      </div>
    </section>

    <!-- Footer -->
    <footer class="report-footer">
      <p>SECUREFLOW AUTOMATED PERIMETER AUDITOR &bull; THE PROFESSOR'S VAULT DEFENSE ENGINE</p>
      <p style="margin-top: 4px; opacity: 0.7;">This document is an encrypted audit capture for security compliance and engineering governance.</p>
    </footer>
  </div>
</body>
</html>`;
}
