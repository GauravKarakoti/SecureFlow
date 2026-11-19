import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";
import { formatPrometheusMetrics } from "@/lib/metrics/prometheus";

const rootDir = path.resolve(__dirname, "..");
const docsDashboardPath = path.join(rootDir, "docs", "observability", "grafana-dashboard.json");
const helmDashboardPath = path.join(
  rootDir,
  "helm",
  "secureflow",
  "dashboards",
  "secureflow-overview.json",
);
const helmValuesPath = path.join(rootDir, "helm", "secureflow", "values.yaml");
const helmSchemaPath = path.join(rootDir, "helm", "secureflow", "values.schema.json");
const helmConfigMapPath = path.join(
  rootDir,
  "helm",
  "secureflow",
  "templates",
  "grafana-dashboard-configmap.yaml",
);
const docsObservabilityPath = path.join(rootDir, "docs", "observability.md");

describe("SecureFlow Grafana Dashboard & Helm ConfigMap (#1784)", () => {
  const KNOWN_EXISTING_METRICS = [
    "secureflow_scans_total",
    "secureflow_prs_blocked_total",
    "secureflow_prs_passed_total",
    "secureflow_prs_total",
    "secureflow_repositories_total",
    "secureflow_findings_total",
    "secureflow_scan_duration_seconds",
    "secureflow_database_live",
  ];

  describe("Dashboard JSON Integrity & Structure", () => {
    it("exports valid JSON at docs/observability/grafana-dashboard.json", () => {
      expect(fs.existsSync(docsDashboardPath)).toBe(true);
      const raw = fs.readFileSync(docsDashboardPath, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it("exports valid JSON at helm/secureflow/dashboards/secureflow-overview.json identical to docs", () => {
      expect(fs.existsSync(helmDashboardPath)).toBe(true);
      const docsContent = fs.readFileSync(docsDashboardPath, "utf8");
      const helmContent = fs.readFileSync(helmDashboardPath, "utf8");
      expect(JSON.parse(docsContent)).toEqual(JSON.parse(helmContent));
    });

    it("conforms to standard Grafana dashboard schema version and properties", () => {
      const dashboard = JSON.parse(fs.readFileSync(docsDashboardPath, "utf8"));

      expect(dashboard.title).toBe("SecureFlow / System Overview");
      expect(dashboard.uid).toBe("secureflow-overview");
      expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(30);
      expect(dashboard.editable).toBe(true);
      expect(Array.isArray(dashboard.panels)).toBe(true);
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);

      // Verify Prometheus datasource template variable exists
      expect(dashboard.templating?.list).toBeDefined();
      const dsVar = dashboard.templating.list.find(
        (v: { name?: string; type?: string; query?: string }) => v.name === "datasource",
      );
      expect(dsVar).toBeDefined();
      expect(dsVar.type).toBe("datasource");
      expect(dsVar.query).toBe("prometheus");
    });

    it("ensures all panels have unique IDs and valid Grafana panel types", () => {
      const dashboard = JSON.parse(fs.readFileSync(docsDashboardPath, "utf8"));
      const panelIds = new Set<number>();
      const validTypes = ["stat", "timeseries", "piechart", "bargauge", "gauge", "text", "row"];

      for (const panel of dashboard.panels) {
        expect(panel.id).toBeDefined();
        expect(panelIds.has(panel.id)).toBe(false);
        panelIds.add(panel.id);

        expect(validTypes).toContain(panel.type);
        expect(panel.title).toBeTruthy();
      }
    });

    it("ensures every visualization panel targets exclusively existing metric names", () => {
      const dashboard = JSON.parse(fs.readFileSync(docsDashboardPath, "utf8"));
      const metricRegex = /secureflow_[a-z0-9_]+/g;

      // Also get the list of metrics emitted by formatPrometheusMetrics
      const dummyMetrics = {
        prsCount: 1,
        secretsCount: 1,
        reposCount: 1,
        scanAverage: 1,
        isLive: true,
        totalScans: 1,
        totalVulnerabilities: 1,
        totalMisconfigs: 1,
        blockedPRs: 1,
        passedPRs: 1,
      };
      const emittedOutput = formatPrometheusMetrics(dummyMetrics);

      let targetCount = 0;
      for (const panel of dashboard.panels) {
        if (panel.type === "row" || panel.type === "text") continue;

        expect(Array.isArray(panel.targets)).toBe(true);
        expect(panel.targets.length).toBeGreaterThanOrEqual(1);

        for (const target of panel.targets) {
          targetCount++;
          expect(target.expr).toBeTruthy();

          const matches = target.expr.match(metricRegex) || [];
          expect(matches.length).toBeGreaterThanOrEqual(1);

          for (const metricName of matches) {
            expect(KNOWN_EXISTING_METRICS).toContain(metricName);
            expect(emittedOutput).toContain(metricName);
          }
        }
      }

      expect(targetCount).toBeGreaterThanOrEqual(8);
    });

    it("does not invent un-emitted metrics (e.g. queue depth, circuit breaker) in panel queries", () => {
      const dashboardContent = fs.readFileSync(docsDashboardPath, "utf8");
      const dashboard = JSON.parse(dashboardContent);

      for (const panel of dashboard.panels) {
        if (panel.type === "row" || panel.type === "text") continue;
        for (const target of panel.targets || []) {
          expect(target.expr).not.toContain("secureflow_queue");
          expect(target.expr).not.toContain("secureflow_circuit");
          expect(target.expr).not.toContain("secureflow_llm");
        }
      }
    });
  });

  describe("Helm ConfigMap & Values Specification", () => {
    it("includes grafana-dashboard-configmap.yaml template", () => {
      expect(fs.existsSync(helmConfigMapPath)).toBe(true);
      const template = fs.readFileSync(helmConfigMapPath, "utf8");

      expect(template).toContain(".Values.grafanaDashboard.enabled");
      expect(template).toContain('grafana_dashboard: "1"');
      expect(template).toContain('.Files.Get "dashboards/secureflow-overview.json"');
    });

    it("has grafanaDashboard disabled by default in values.yaml", () => {
      expect(fs.existsSync(helmValuesPath)).toBe(true);
      const values = yaml.parse(fs.readFileSync(helmValuesPath, "utf8"));

      expect(values.grafanaDashboard).toBeDefined();
      expect(values.grafanaDashboard.enabled).toBe(false);
      expect(values.grafanaDashboard.namespace).toBe("");
      expect(values.grafanaDashboard.additionalLabels).toEqual({});
    });

    it("validates grafanaDashboard schema in values.schema.json", () => {
      expect(fs.existsSync(helmSchemaPath)).toBe(true);
      const schema = JSON.parse(fs.readFileSync(helmSchemaPath, "utf8"));

      expect(schema.properties.grafanaDashboard).toBeDefined();
      expect(schema.properties.grafanaDashboard.properties.enabled.type).toBe("boolean");
      expect(schema.properties.grafanaDashboard.properties.namespace.type).toBe("string");
      expect(schema.properties.grafanaDashboard.properties.additionalLabels.type).toBe("object");
    });
  });

  describe("Observability Documentation", () => {
    it("documents dashboard import steps, panel descriptions, and follow-up metrics", () => {
      expect(fs.existsSync(docsObservabilityPath)).toBe(true);
      const doc = fs.readFileSync(docsObservabilityPath, "utf8");

      // Documentation references
      expect(doc).toContain("Ready-Made Grafana Dashboard (#1784)");
      expect(doc).toContain("docs/observability/grafana-dashboard.json");
      expect(doc).toContain("grafanaDashboard.enabled=true");
      expect(doc).toContain('grafana_dashboard: "1"');

      // Check all existing metrics are listed
      for (const metric of KNOWN_EXISTING_METRICS) {
        expect(doc).toContain(metric);
      }

      // Check follow-up missing metrics are documented
      expect(doc).toContain("Follow-Up Observability Roadmap");
      expect(doc).toContain("Queue Depth");
      expect(doc).toContain("LLM Inference Provider");
      expect(doc).toContain("Circuit Breaker");
    });
  });
});
