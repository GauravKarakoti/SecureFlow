import { describe, it, expect } from "vitest";
import { formatPrometheusMetrics, PROMETHEUS_CONTENT_TYPE } from "./prometheus";
import type { DetailedLandingMetrics } from "./landing-stats";

describe("formatPrometheusMetrics (#1784)", () => {
  const sampleMetrics: DetailedLandingMetrics = {
    prsCount: 300,
    secretsCount: 42,
    reposCount: 15,
    scanAverage: 1.4,
    isLive: true,
    totalScans: 400,
    totalVulnerabilities: 20,
    totalMisconfigs: 10,
    blockedPRs: 5,
    passedPRs: 295,
  };

  it("exports correct Prometheus content type header", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("formats metrics into valid Prometheus line format with HELP and TYPE", () => {
    const output = formatPrometheusMetrics(sampleMetrics);

    // Scan counts
    expect(output).toContain("# HELP secureflow_scans_total");
    expect(output).toContain("# TYPE secureflow_scans_total counter");
    expect(output).toContain("secureflow_scans_total 400");

    // Blocked & passed PRs
    expect(output).toContain("secureflow_prs_blocked_total 5");
    expect(output).toContain("secureflow_prs_passed_total 295");

    // PRs & Repositories
    expect(output).toContain("secureflow_prs_total 300");
    expect(output).toContain("secureflow_repositories_total 15");

    // Findings by type
    expect(output).toContain('secureflow_findings_total{type="secret"} 42');
    expect(output).toContain('secureflow_findings_total{type="vulnerability"} 20');
    expect(output).toContain('secureflow_findings_total{type="misconfig"} 10');

    // Scan average & liveness
    expect(output).toContain("secureflow_scan_duration_seconds 1.4");
    expect(output).toContain("secureflow_database_live 1");
  });

  it("formats database_live as 0 when isLive is false", () => {
    const degradedMetrics = { ...sampleMetrics, isLive: false };
    const output = formatPrometheusMetrics(degradedMetrics);

    expect(output).toContain("secureflow_database_live 0");
  });

  it("formats queue depth per installation when present (#1980)", () => {
    const metricsWithQueue: DetailedLandingMetrics = {
      ...sampleMetrics,
      queueDepthPerInstallation: {
        "12345": 4,
        "67890": 1,
      },
    };
    const output = formatPrometheusMetrics(metricsWithQueue);

    expect(output).toContain("# HELP secureflow_queue_depth_per_installation");
    expect(output).toContain("# TYPE secureflow_queue_depth_per_installation gauge");
    expect(output).toContain('secureflow_queue_depth_per_installation{installation="12345"} 4');
    expect(output).toContain('secureflow_queue_depth_per_installation{installation="67890"} 1');
  });
});
