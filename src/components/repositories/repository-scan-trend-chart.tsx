"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
import {
  Activity,
  TrendingDown,
  TrendingUp,
  Minus,
  AlertCircle,
  RefreshCw,
  LineChart as LineChartIcon,
  BarChart3,
  ShieldAlert,
  GitPullRequest,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type {
  RepositoryScanTrendResponse,
  ScanSeverityTrendItem,
} from "@/lib/repositories/scan-trend";

export interface RepositoryOption {
  id: string;
  fullName: string;
}

export interface RepositoryScanTrendChartProps {
  repositoryId?: string;
  repositories?: RepositoryOption[];
  defaultRange?: 7 | 30 | 90;
  initialChartType?: "line" | "bar";
  className?: string;
}

const SEVERITY_COLORS = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
} as const;

export function RepositoryScanTrendChart({
  repositoryId,
  repositories = [],
  defaultRange = 30,
  initialChartType = "line",
  className = "",
}: RepositoryScanTrendChartProps) {
  const [selectedRepoId, setSelectedRepoId] = useState<string>(
    repositoryId || repositories[0]?.id || "",
  );
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(defaultRange);
  const [chartType, setChartType] = useState<"line" | "bar">(initialChartType);
  const [data, setData] = useState<RepositoryScanTrendResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(selectedRepoId));
  const [error, setError] = useState<string | null>(null);

  const selectId = useId();

  // Keep selectedRepoId in sync if repositoryId prop changes
  useEffect(() => {
    if (repositoryId && repositoryId !== selectedRepoId) {
      setSelectedRepoId(repositoryId);
    } else if (!selectedRepoId && repositories.length > 0) {
      setSelectedRepoId(repositories[0].id);
    }
  }, [repositoryId, repositories, selectedRepoId]);

  const fetchData = useCallback(async (repoId: string, days: number) => {
    if (!repoId) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/repositories/${repoId}/scans?days=${days}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed to fetch scan data (${response.status})`);
      }

      const json: RepositoryScanTrendResponse = await response.json();
      setData(json);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to load scan trend data";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedRepoId) {
      fetchData(selectedRepoId, rangeDays);
    }
  }, [selectedRepoId, rangeDays, fetchData]);

  const scans = data?.scans || [];
  const hasInsufficientScans = scans.length < 2;

  // Trend direction analysis comparing first scan to latest scan in window
  const trendAnalysis = React.useMemo(() => {
    if (scans.length < 2) return null;
    const firstScan = scans[0];
    const latestScan = scans[scans.length - 1];
    const totalDiff = latestScan.total - firstScan.total;
    const critDiff = latestScan.critical - firstScan.critical;

    if (totalDiff < 0 || (totalDiff === 0 && critDiff < 0)) {
      return {
        direction: "safer" as const,
        label: "Safer Over Time",
        summary: `Findings decreased from ${firstScan.total} to ${latestScan.total} (${totalDiff})`,
        badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        icon: <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />,
      };
    }
    if (totalDiff > 0 || critDiff > 0) {
      return {
        direction: "riskier" as const,
        label: "Riskier Over Time",
        summary: `Findings increased from ${firstScan.total} to ${latestScan.total} (+${totalDiff})`,
        badgeClass: "bg-rose-500/15 text-rose-400 border-rose-500/30",
        icon: <TrendingUp className="w-3.5 h-3.5 text-rose-400" />,
      };
    }
    return {
      direction: "stable" as const,
      label: "Stable Posture",
      summary: `Findings unchanged at ${latestScan.total} across ${scans.length} scans`,
      badgeClass: "bg-zinc-800 text-zinc-300 border-zinc-700",
      icon: <Minus className="w-3.5 h-3.5 text-zinc-400" />,
    };
  }, [scans]);

  // Transform data points for Recharts
  const chartPoints = React.useMemo(() => {
    return scans.map((scan, index) => {
      // Short date label: MM/DD
      const dateParts = scan.date.split("-");
      const shortDate = dateParts.length >= 3 ? `${dateParts[1]}/${dateParts[2]}` : scan.date;
      const label = scan.prNumber > 0 ? `PR #${scan.prNumber} (${shortDate})` : shortDate;

      return {
        ...scan,
        label,
        index: index + 1,
      };
    });
  }, [scans]);

  const selectedRepoName =
    data?.repositoryName ||
    repositories.find((r) => r.id === selectedRepoId)?.fullName ||
    "Repository";

  return (
    <Card
      data-testid="repository-scan-trend-chart"
      className={`border-white/10 bg-card/60 shadow-lg ${className}`}
    >
      <CardHeader className="pb-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <CardTitle className="text-base font-bold font-headline uppercase tracking-wider text-foreground">
                Scan Severity Trend
              </CardTitle>
              {trendAnalysis && (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-semibold border ${trendAnalysis.badgeClass}`}
                >
                  {trendAnalysis.icon}
                  {trendAnalysis.label}
                </span>
              )}
            </div>
            <CardDescription className="text-xs font-mono text-muted-foreground">
              Vulnerability counts per severity per scan to observe whether security posture is
              improving or degrading over time.
            </CardDescription>
          </div>

          {/* Controls: Repo selector + Range buttons + Chart mode */}
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Repository switcher if multiple repos */}
            {repositories.length > 1 && (
              <div className="flex items-center gap-1.5 bg-zinc-900/80 border border-zinc-800 rounded-md px-2.5 py-1 text-xs font-mono">
                <label htmlFor={selectId} className="text-muted-foreground sr-only">
                  Select Repository:
                </label>
                <select
                  id={selectId}
                  aria-label="Select Repository"
                  value={selectedRepoId}
                  onChange={(e) => setSelectedRepoId(e.target.value)}
                  className="bg-transparent text-foreground focus:outline-none cursor-pointer max-w-[160px] truncate"
                >
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id} className="bg-zinc-900">
                      Repo: {repo.fullName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* 7/30/90 Day Range Selector */}
            <div
              data-testid="range-selector"
              role="group"
              aria-label="Time range selector"
              className="flex items-center rounded-md border border-white/10 bg-zinc-900/80 p-0.5 text-xs font-mono"
            >
              {([7, 30, 90] as const).map((r) => {
                const active = rangeDays === r;
                return (
                  <button
                    key={r}
                    type="button"
                    data-testid={`range-${r}`}
                    aria-pressed={active}
                    onClick={() => setRangeDays(r)}
                    className={`rounded px-2.5 py-1 transition-colors ${
                      active
                        ? "bg-primary/20 text-primary font-bold shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r}d
                  </button>
                );
              })}
            </div>

            {/* Chart type toggle */}
            <div
              role="group"
              aria-label="Chart display type"
              className="flex items-center rounded-md border border-white/10 bg-zinc-900/80 p-0.5 text-xs font-mono"
            >
              <button
                type="button"
                data-testid="chart-type-line"
                aria-pressed={chartType === "line"}
                onClick={() => setChartType("line")}
                title="Line chart view"
                className={`rounded px-2 py-1 transition-colors flex items-center gap-1 ${
                  chartType === "line"
                    ? "bg-primary/20 text-primary font-bold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <LineChartIcon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Line</span>
              </button>
              <button
                type="button"
                data-testid="chart-type-bar"
                aria-pressed={chartType === "bar"}
                onClick={() => setChartType("bar")}
                title="Stacked bar chart view"
                className={`rounded px-2 py-1 transition-colors flex items-center gap-1 ${
                  chartType === "bar"
                    ? "bg-primary/20 text-primary font-bold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <BarChart3 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Stacked</span>
              </button>
            </div>
          </div>
        </div>

        {trendAnalysis && (
          <div className="pt-2 text-xs font-mono text-muted-foreground flex items-center gap-2">
            <span>Summary:</span>
            <span className="text-foreground">{trendAnalysis.summary}</span>
          </div>
        )}
      </CardHeader>

      <CardContent>
        {/* Loading State */}
        {loading && (
          <div
            data-testid="trend-loading-state"
            role="status"
            aria-busy="true"
            className="h-[300px] flex flex-col items-center justify-center gap-3 text-muted-foreground font-mono text-xs border border-dashed border-white/5 rounded-lg bg-zinc-950/20"
          >
            <RefreshCw className="w-6 h-6 animate-spin text-primary" />
            <span>Loading scan severity trend...</span>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div
            data-testid="trend-error-state"
            role="alert"
            className="h-[300px] flex flex-col items-center justify-center gap-3 p-6 text-center border border-dashed border-rose-500/20 rounded-lg bg-rose-500/5 font-mono text-xs"
          >
            <AlertCircle className="w-8 h-8 text-rose-400" />
            <div className="space-y-1">
              <p className="font-bold text-rose-300">Unable to load scan severity trends</p>
              <p className="text-zinc-400">{error}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="trend-retry-button"
              onClick={() => fetchData(selectedRepoId, rangeDays)}
              className="mt-2 text-xs font-mono border-rose-500/30 hover:bg-rose-500/10 text-rose-300 gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </Button>
          </div>
        )}

        {/* Empty State: Repositories with fewer than two scans */}
        {!loading && !error && hasInsufficientScans && (
          <div
            data-testid="insufficient-scans-empty-state"
            className="h-[300px] flex flex-col items-center justify-center gap-3 p-6 text-center border border-dashed border-zinc-800 rounded-lg bg-zinc-950/30 font-mono"
          >
            <ShieldAlert className="w-10 h-10 text-zinc-500 mb-1" />
            <h4 className="text-sm font-bold uppercase tracking-wider text-foreground">
              Insufficient Scan History
            </h4>
            <p className="text-xs text-muted-foreground max-w-md">
              Fewer than two scans recorded in the last {rangeDays} days. At least two scans are
              required to plot security trends over time. Run more pull request scans to visualize
              whether this repository is getting safer or riskier.
            </p>
            <div className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-zinc-900 border border-zinc-800 text-zinc-400">
              <GitPullRequest className="w-3.5 h-3.5 text-zinc-500" />
              <span>
                Currently:{" "}
                <strong className="text-foreground">
                  {scans.length === 0
                    ? "0 scans recorded"
                    : `1 scan recorded (PR #${scans[0].prNumber} with ${scans[0].total} findings)`}
                </strong>
              </span>
            </div>
          </div>
        )}

        {/* Chart View (When 2 or more scans are recorded) */}
        {!loading && !error && !hasInsufficientScans && (
          <div
            role="region"
            aria-label={`Scan severity trend chart for ${selectedRepoName} over the last ${rangeDays} days`}
            tabIndex={0}
            className="h-[320px] w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-lg"
          >
            <span className="sr-only">
              {chartType === "line" ? "Line chart" : "Stacked bar chart"} showing critical, high,
              medium, and low finding counts across {scans.length} scans for {selectedRepoName}.
            </span>
            <ResponsiveContainer width="100%" height="100%" minWidth={100} minHeight={200}>
              {chartType === "line" ? (
                <LineChart data={chartPoints} accessibilityLayer>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const item = payload[0].payload as ScanSeverityTrendItem;
                      return (
                        <div className="bg-zinc-950/95 border border-zinc-800 rounded-lg p-3 shadow-xl font-mono text-xs space-y-2">
                          <div className="border-b border-zinc-800 pb-1.5">
                            <p className="font-bold text-foreground flex items-center justify-between gap-4">
                              <span>PR #{item.prNumber}</span>
                              <span className="text-[10px] text-zinc-400">{item.date}</span>
                            </p>
                            {item.prTitle && (
                              <p className="text-[11px] text-zinc-400 truncate max-w-[220px]">
                                {item.prTitle}
                              </p>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                            <span className="text-rose-400 font-semibold">
                              Critical: {item.critical}
                            </span>
                            <span className="text-orange-400 font-semibold">High: {item.high}</span>
                            <span className="text-yellow-400">Medium: {item.medium}</span>
                            <span className="text-blue-400">Low: {item.low}</span>
                          </div>
                          <div className="border-t border-zinc-800 pt-1.5 flex items-center justify-between text-[11px] text-zinc-400">
                            <span>Total Findings:</span>
                            <span className="font-bold text-foreground">{item.total}</span>
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Decision: {item.policyDecision}</span>
                            <span>Risk Score: {item.riskScore}</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: "11px", paddingTop: "12px", fontFamily: "monospace" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="critical"
                    name="Critical"
                    stroke={SEVERITY_COLORS.critical}
                    strokeWidth={2}
                    dot={{ r: 3, fill: SEVERITY_COLORS.critical }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="high"
                    name="High"
                    stroke={SEVERITY_COLORS.high}
                    strokeWidth={2}
                    dot={{ r: 3, fill: SEVERITY_COLORS.high }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="medium"
                    name="Medium"
                    stroke={SEVERITY_COLORS.medium}
                    strokeWidth={2}
                    dot={{ r: 3, fill: SEVERITY_COLORS.medium }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="low"
                    name="Low"
                    stroke={SEVERITY_COLORS.low}
                    strokeWidth={2}
                    dot={{ r: 3, fill: SEVERITY_COLORS.low }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              ) : (
                <BarChart data={chartPoints} accessibilityLayer>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload || !payload.length) return null;
                      const item = payload[0].payload as ScanSeverityTrendItem;
                      return (
                        <div className="bg-zinc-950/95 border border-zinc-800 rounded-lg p-3 shadow-xl font-mono text-xs space-y-2">
                          <div className="border-b border-zinc-800 pb-1.5">
                            <p className="font-bold text-foreground flex items-center justify-between gap-4">
                              <span>PR #{item.prNumber}</span>
                              <span className="text-[10px] text-zinc-400">{item.date}</span>
                            </p>
                            {item.prTitle && (
                              <p className="text-[11px] text-zinc-400 truncate max-w-[220px]">
                                {item.prTitle}
                              </p>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                            <span className="text-rose-400 font-semibold">
                              Critical: {item.critical}
                            </span>
                            <span className="text-orange-400 font-semibold">High: {item.high}</span>
                            <span className="text-yellow-400">Medium: {item.medium}</span>
                            <span className="text-blue-400">Low: {item.low}</span>
                          </div>
                          <div className="border-t border-zinc-800 pt-1.5 flex items-center justify-between text-[11px] text-zinc-400">
                            <span>Total Findings:</span>
                            <span className="font-bold text-foreground">{item.total}</span>
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-zinc-500">
                            <span>Decision: {item.policyDecision}</span>
                            <span>Risk Score: {item.riskScore}</span>
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: "11px", paddingTop: "12px", fontFamily: "monospace" }}
                  />
                  <Bar
                    dataKey="critical"
                    name="Critical"
                    stackId="severity"
                    fill={SEVERITY_COLORS.critical}
                  />
                  <Bar dataKey="high" name="High" stackId="severity" fill={SEVERITY_COLORS.high} />
                  <Bar
                    dataKey="medium"
                    name="Medium"
                    stackId="severity"
                    fill={SEVERITY_COLORS.medium}
                  />
                  <Bar
                    dataKey="low"
                    name="Low"
                    stackId="severity"
                    fill={SEVERITY_COLORS.low}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
export default RepositoryScanTrendChart;
