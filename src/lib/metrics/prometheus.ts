import type { DetailedLandingMetrics } from "./landing-stats";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * Formats DetailedLandingMetrics into the standard Prometheus exposition text format (version 0.0.4).
 *
 * Each metric is documented with standard Prometheus HELP and TYPE annotations.
 * Metric names follow Prometheus naming guidelines (base unit in name, counter/total suffix).
 */
export function formatPrometheusMetrics(metrics: DetailedLandingMetrics): string {
  const lines: string[] = [
    "# HELP secureflow_scans_total Total scans completed across all repositories",
    "# TYPE secureflow_scans_total counter",
    `secureflow_scans_total ${metrics.totalScans}`,
    "",
    "# HELP secureflow_prs_blocked_total Total pull requests blocked due to policy violations",
    "# TYPE secureflow_prs_blocked_total counter",
    `secureflow_prs_blocked_total ${metrics.blockedPRs}`,
    "",
    "# HELP secureflow_prs_passed_total Total pull requests passed without blocking policy violations",
    "# TYPE secureflow_prs_passed_total counter",
    `secureflow_prs_passed_total ${metrics.passedPRs}`,
    "",
    "# HELP secureflow_prs_total Total pull requests tracked",
    "# TYPE secureflow_prs_total gauge",
    `secureflow_prs_total ${metrics.prsCount}`,
    "",
    "# HELP secureflow_repositories_total Total active repositories monitored",
    "# TYPE secureflow_repositories_total gauge",
    `secureflow_repositories_total ${metrics.reposCount}`,
    "",
    "# HELP secureflow_findings_total Total security findings by finding type",
    "# TYPE secureflow_findings_total gauge",
    `secureflow_findings_total{type="secret"} ${metrics.secretsCount}`,
    `secureflow_findings_total{type="vulnerability"} ${metrics.totalVulnerabilities}`,
    `secureflow_findings_total{type="misconfig"} ${metrics.totalMisconfigs}`,
    "",
    "# HELP secureflow_scan_duration_seconds Advertised average scan duration in seconds",
    "# TYPE secureflow_scan_duration_seconds gauge",
    `secureflow_scan_duration_seconds ${metrics.scanAverage}`,
    "",
    "# HELP secureflow_database_live Database connectivity indicator (1 = healthy, 0 = degraded)",
    "# TYPE secureflow_database_live gauge",
    `secureflow_database_live ${metrics.isLive ? 1 : 0}`,
    "",
  ];

  if (
    metrics.queueDepthPerInstallation &&
    Object.keys(metrics.queueDepthPerInstallation).length > 0
  ) {
    lines.push(
      "# HELP secureflow_queue_depth_per_installation Current waiting queue depth per installation",
      "# TYPE secureflow_queue_depth_per_installation gauge",
    );
    for (const [instId, depth] of Object.entries(metrics.queueDepthPerInstallation)) {
      lines.push(`secureflow_queue_depth_per_installation{installation="${instId}"} ${depth}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
