"use client";

import React, { useState, useCallback, useMemo } from "react";
import Link from "next/link";
import CountUp from "react-countup";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimeAgo } from "@/components/time-ago";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RepoHotspotGroup, DirectoryHotspot } from "@/lib/analytics/hotspots";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Minus,
  Download,
  Shield,
  Target,
  Activity,
  CheckCircle,
  CheckCircle2,
  AlertTriangle,
  AlertOctagon,
  AlertCircle,
  Clock,
  Filter,
  Folder,
  Layers,
  ArrowRight,
} from "lucide-react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { ANALYTICS_RANGES, DEFAULT_ANALYTICS_RANGE } from "@/lib/analytics/range";

// ─── Types ───────────────────────────────────────────────────────────────────

interface DailyScanMetric {
  date: string;
  scans: number;
  findings: number;
  criticalFindings: number;
  avgRiskScore: number;
}

interface SeverityTrendPoint {
  date: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface RepoScanSummary {
  repositoryId: string;
  repositoryName: string;
  totalScans: number;
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  averageRiskScore: number;
  lastScanAt: string | null;
  passRate: number;
}

interface TopFindingType {
  type: string;
  count: number;
  percentage: number;
}

interface ScanVelocity {
  period: string;
  count: number;
}

interface AnalyticsSummary {
  totalScans: number;
  totalFindings: number;
  totalPRs: number;
  overallPassRate: number;
  avgRiskScore: number;
  trendDirection: "up" | "down" | "flat";
  /** Count of open findings that have exceeded their target resolution age. */
  overdueFindings: number;
  /** Average resolution time formatted (e.g. "4.2h" or "1.5d") (#1869). */
  avgResolutionTime?: string | null;
  /** Count of resolved findings. */
  resolvedFindings?: number;
}

interface AnalyticsClientProps {
  /** The window the charts cover, from `?range=` (see `parseAnalyticsRange`). */
  rangeDays?: number;
  dailyMetrics: DailyScanMetric[];
  severityTrend: SeverityTrendPoint[];
  repoSummaries: RepoScanSummary[];
  topFindingTypes: TopFindingType[];
  scanVelocity: ScanVelocity[];
  summary: AnalyticsSummary;
  hotspots?: RepoHotspotGroup[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

const FINDING_TYPE_COLORS = [
  "#8b5cf6",
  "#06b6d4",
  "#f97316",
  "#22c55e",
  "#ef4444",
  "#eab308",
  "#ec4899",
  "#6366f1",
  "#14b8a6",
  "#a855f7",
];

const TREND_ICONS = {
  up: <TrendingUp className="w-4 h-4 text-red-400" />,
  down: <TrendingDown className="w-4 h-4 text-green-400" />,
  flat: <Minus className="w-4 h-4 text-muted-foreground" />,
};

const TREND_LABELS: Record<string, string> = {
  up: "Finding trends increasing",
  down: "Finding trends decreasing",
  flat: "Finding trends stable",
};

// ─── Client Component ────────────────────────────────────────────────────────

export default function AnalyticsClient({
  rangeDays = DEFAULT_ANALYTICS_RANGE,
  dailyMetrics,
  severityTrend,
  repoSummaries,
  topFindingTypes,
  scanVelocity,
  summary,
  hotspots = [],
}: AnalyticsClientProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "hotspots">("overview");
  const [selectedHotspotRepoId, setSelectedHotspotRepoId] = useState<string>(() => {
    return hotspots[0]?.repositoryId || repoSummaries[0]?.repositoryId || "";
  });
  const [selectedDepth, setSelectedDepth] = useState<number>(1);
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [exporting, setExporting] = useState(false);

  const visibleRepos = useMemo(
    () => (showAllRepos ? repoSummaries : repoSummaries.slice(0, 5)),
    [showAllRepos, repoSummaries],
  );

  const handleExportCSV = useCallback(() => {
    setExporting(true);

    try {
      const headers = [
        "Repository",
        "Total Scans",
        "Total Findings",
        "Critical",
        "High",
        "Medium",
        "Low",
        "Avg Risk Score",
        "Pass Rate (%)",
        "Last Scan",
      ];

      const rows = repoSummaries.map((r) => [
        r.repositoryName,
        r.totalScans.toString(),
        r.totalFindings.toString(),
        r.criticalFindings.toString(),
        r.highFindings.toString(),
        r.mediumFindings.toString(),
        r.lowFindings.toString(),
        r.averageRiskScore.toString(),
        r.passRate.toString(),
        r.lastScanAt ? new Date(r.lastScanAt).toLocaleDateString() : "Never",
      ]);

      const csvContent = [headers, ...rows].map((row) => row.join(",")).join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `secureflow-analytics-${new Date().toISOString().split("T")[0]}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [repoSummaries]);

  const handleExportJSON = useCallback(() => {
    setExporting(true);

    try {
      const exportData = {
        exportedAt: new Date().toISOString(),
        rangeDays,
        summary,
        dailyMetrics,
        severityTrend,
        repoSummaries,
        topFindingTypes,
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `secureflow-analytics-${rangeDays}d-${new Date().toISOString().split("T")[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [rangeDays, summary, dailyMetrics, severityTrend, repoSummaries, topFindingTypes]);

  const pieData = useMemo(
    () =>
      topFindingTypes.map((ft) => ({
        name: ft.type,
        value: ft.count,
      })),
    [topFindingTypes],
  );

  const currentHotspotGroup = useMemo(() => {
    return hotspots.find((h) => h.repositoryId === selectedHotspotRepoId) || hotspots[0] || null;
  }, [hotspots, selectedHotspotRepoId]);

  const currentHotspots = useMemo(() => {
    if (!currentHotspotGroup) return [];
    return currentHotspotGroup.hotspotsByDepth[selectedDepth] || [];
  }, [currentHotspotGroup, selectedDepth]);

  return (
    <div className="space-y-8 w-full animate-in fade-in duration-700">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-sm font-medium uppercase tracking-widest text-primary">
            Security Center
          </span>
          <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
            Analytics & Trends
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Deep dive into scan history, finding trends, directory hotspots, and repository security
            posture over time.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {TREND_ICONS[summary.trendDirection]}
              <span className="text-xs font-medium text-muted-foreground">
                {TREND_LABELS[summary.trendDirection]}
              </span>
            </div>
            <nav
              aria-label="Time range"
              className="flex items-center rounded-md border border-white/10 bg-white/5 p-0.5"
            >
              {ANALYTICS_RANGES.map((range) => {
                const active = range === rangeDays;
                return (
                  <Link
                    key={range}
                    href={`?range=${range}`}
                    scroll={false}
                    aria-current={active ? "page" : undefined}
                    className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded px-3 py-1 font-mono text-xs transition-colors ${
                      active
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {range}d
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={exporting}
            className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer font-mono text-xs min-h-[44px]"
          >
            <Download className="w-3.5 h-3.5 mr-2" />
            {exporting ? "Exporting..." : "Export CSV"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportJSON}
            disabled={exporting}
            className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer font-mono text-xs min-h-[44px]"
          >
            <Download className="w-3.5 h-3.5 mr-2" />
            Export JSON
          </Button>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="border-[#5A29E4]/40 hover:border-[#5A29E4] bg-[#5A29E4]/10 text-violet-300 cursor-pointer font-mono text-xs min-h-[44px]"
          >
            <a href="/api/findings/export?format=html" target="_blank" rel="noopener noreferrer">
              Shareable Report
            </a>
          </Button>
        </div>
      </div>

      {/* Tabs: Overview & Trends vs Hotspots */}
      <Tabs
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as "overview" | "hotspots")}
        className="w-full space-y-6"
      >
        <TabsList className="bg-white/5 border border-white/10 p-1">
          <TabsTrigger
            value="overview"
            onClick={() => setActiveTab("overview")}
            className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary"
          >
            Overview & Trends
          </TabsTrigger>
          <TabsTrigger
            value="hotspots"
            onClick={() => setActiveTab("hotspots")}
            data-testid="hotspots-tab-trigger"
            className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary flex items-center gap-2"
          >
            <Folder className="w-4 h-4" />
            <span>Hotspots</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="overview"
          forceMount={activeTab === "overview" ? true : undefined}
          className={`space-y-8 mt-0 ${activeTab !== "overview" ? "hidden" : ""}`}
        >
          {/* Summary Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <SummaryCard
              title="Total Scans"
              value={summary.totalScans}
              icon={<Activity className="w-5 h-5 text-primary" />}
              color="primary"
            />
            <SummaryCard
              title="Total Findings"
              value={summary.totalFindings}
              icon={<Shield className="w-5 h-5 text-orange-400" />}
              color="orange"
            />
            <SummaryCard
              title="Pass Rate"
              value={summary.overallPassRate}
              suffix="%"
              icon={<CheckCircle className="w-5 h-5 text-green-400" />}
              color="green"
            />
            <SummaryCard
              title="Avg Risk Score"
              value={summary.avgRiskScore}
              icon={<Target className="w-5 h-5 text-blue-400" />}
              color="blue"
            />
            <SummaryCard
              title="Avg Resolution"
              value={summary.avgResolutionTime ?? "N/A"}
              icon={<Clock className="w-5 h-5 text-emerald-400" />}
              color="green"
            />
          </div>

          {/* Overdue Findings Banner */}
          {summary.overdueFindings > 0 && (
            <div className="flex items-center gap-4 p-4 rounded-xl bg-red-500/10 border border-red-500/30">
              <AlertCircle className="w-6 h-6 text-red-400 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-red-300">
                  {summary.overdueFindings.toLocaleString()} overdue{" "}
                  {summary.overdueFindings === 1 ? "finding" : "findings"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  These open findings have exceeded their target resolution age. Dismissed findings
                  are excluded.
                </p>
              </div>
              <Link
                href="/dashboard/findings?status=OPEN"
                className="text-xs font-mono text-red-300 hover:text-red-100 underline underline-offset-2 shrink-0"
              >
                View findings →
              </Link>
            </div>
          )}

          {/* Themed Heist Risk & Vault Integrity Metrics (#1711) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-4 rounded-xl bg-gradient-to-r from-[#5A29E4]/15 via-[#5A29E4]/5 to-transparent border border-[#5A29E4]/30 glass-card flex items-center justify-between">
              <div>
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-violet-400">
                  Heist Risk Score
                </span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-headline font-bold text-foreground">
                    {Math.round(summary.avgRiskScore)}
                  </span>
                  <span className="text-xs font-mono text-muted-foreground">/ 100 Index</span>
                </div>
              </div>
              <Badge className="bg-[#5A29E4]/25 text-violet-300 border-[#5A29E4]/40 font-mono text-xs">
                {summary.avgRiskScore < 25
                  ? "MINIMAL"
                  : summary.avgRiskScore < 50
                    ? "GUARDED"
                    : summary.avgRiskScore < 80
                      ? "ELEVATED"
                      : "CRITICAL"}
              </Badge>
            </div>

            <div className="p-4 rounded-xl bg-gradient-to-r from-[#0A5C3E]/20 via-[#0A5C3E]/5 to-transparent border border-[#0A5C3E]/40 glass-card flex items-center justify-between">
              <div>
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
                  Vault Integrity Status
                </span>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-2xl font-headline font-bold text-foreground">
                    {summary.overallPassRate}%
                  </span>
                  <span className="text-xs font-mono text-muted-foreground">
                    Perimeter Clearance
                  </span>
                </div>
              </div>
              <Badge className="bg-[#0A5C3E] text-emerald-100 border-emerald-500/40 font-mono text-xs">
                {summary.overallPassRate >= 90
                  ? "FORTIFIED"
                  : summary.overallPassRate >= 75
                    ? "SECURED"
                    : summary.overallPassRate >= 50
                      ? "GUARDED"
                      : "COMPROMISED"}
              </Badge>
            </div>
          </div>

          {/* Scan Activity + Scan Velocity */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
            <Card className="lg:col-span-2 glass-card">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold">Scan Activity & Findings</CardTitle>
                <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                  Last {rangeDays} Days
                </Badge>
              </CardHeader>
              <CardContent className="h-[320px]">
                {dailyMetrics.length === 0 || dailyMetrics.every((d) => d.scans === 0) ? (
                  <EmptyState
                    icon={<Activity className="mb-4 h-12 w-12 text-primary opacity-60" />}
                    title="No Scan Data"
                    description="Analytics will appear after your first repository scan."
                  />
                ) : (
                  <div
                    role="region"
                    aria-label={`Scan activity and findings trend chart for the last ${rangeDays} days`}
                    tabIndex={0}
                    className="h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                  >
                    <span className="sr-only">
                      Area chart showing daily scans and findings trends over the last {rangeDays}{" "}
                      days.
                    </span>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={dailyMetrics} accessibilityLayer>
                        <defs>
                          <linearGradient id="gradientScans" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="gradientFindings" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#f97316" stopOpacity={0.4} />
                            <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "rgba(0,0,0,0.8)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            borderRadius: "8px",
                            fontSize: "12px",
                          }}
                        />
                        <Legend />
                        <Area
                          type="monotone"
                          dataKey="scans"
                          name="Scans"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          fill="url(#gradientScans)"
                        />
                        <Area
                          type="monotone"
                          dataKey="findings"
                          name="Findings"
                          stroke="#f97316"
                          strokeWidth={2}
                          fill="url(#gradientFindings)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-bold">Finding Types</CardTitle>
              </CardHeader>
              <CardContent className="h-[320px]">
                {pieData.length === 0 ? (
                  <EmptyState
                    icon={<Shield className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />}
                    title="No Findings"
                    description="Finding distribution will appear here after scans."
                  />
                ) : (
                  <div className="flex flex-col h-full">
                    <div
                      role="region"
                      aria-label="Finding types distribution pie chart"
                      tabIndex={0}
                      className="flex-1 min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                    >
                      <span className="sr-only">
                        Pie chart showing distribution of finding types across scanned repositories.
                      </span>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart accessibilityLayer>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={50}
                            outerRadius={80}
                            paddingAngle={3}
                            dataKey="value"
                          >
                            {pieData.map((_, index) => (
                              <Cell
                                key={`cell-${index}`}
                                fill={FINDING_TYPE_COLORS[index % FINDING_TYPE_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "rgba(0,0,0,0.8)",
                              border: "1px solid rgba(255,255,255,0.1)",
                              borderRadius: "8px",
                              fontSize: "12px",
                            }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-2 space-y-1.5 max-h-[100px] overflow-y-auto">
                      {topFindingTypes.slice(0, 5).map((ft, i) => (
                        <div key={ft.type} className="flex items-center gap-2 text-xs">
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{
                              backgroundColor: FINDING_TYPE_COLORS[i % FINDING_TYPE_COLORS.length],
                            }}
                          />
                          <span className="truncate text-muted-foreground">{ft.type}</span>
                          <span className="ml-auto font-mono font-bold">{ft.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Severity Trend Stacked Bar Chart */}
          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-bold">Severity Trend Over Time</CardTitle>
              <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                Stacked by Severity
              </Badge>
            </CardHeader>
            <CardContent className="h-[300px]">
              {severityTrend.length === 0 ||
              severityTrend.every((s) => s.critical + s.high + s.medium + s.low === 0) ? (
                <EmptyState
                  icon={<BarChart3 className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />}
                  title="No Severity Data"
                  description="Severity distribution trends will appear after scans produce findings."
                />
              ) : (
                <div
                  role="region"
                  aria-label="Severity trend stacked bar chart over time"
                  tabIndex={0}
                  className="h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                >
                  <span className="sr-only">
                    Stacked bar chart displaying critical, high, medium, and low severity trends
                    over time.
                  </span>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={severityTrend} accessibilityLayer>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "rgba(0,0,0,0.8)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                      />
                      <Legend />
                      <Bar
                        dataKey="critical"
                        name="Critical"
                        stackId="a"
                        fill={SEVERITY_COLORS.critical}
                      />
                      <Bar dataKey="high" name="High" stackId="a" fill={SEVERITY_COLORS.high} />
                      <Bar
                        dataKey="medium"
                        name="Medium"
                        stackId="a"
                        fill={SEVERITY_COLORS.medium}
                      />
                      <Bar dataKey="low" name="Low" stackId="a" fill={SEVERITY_COLORS.low} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top Finding Types Bar Chart */}
          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-bold">Top Finding Types</CardTitle>
              <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                By Frequency
              </Badge>
            </CardHeader>
            <CardContent className="h-[280px]">
              {topFindingTypes.length === 0 ? (
                <EmptyState
                  icon={
                    <AlertTriangle className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
                  }
                  title="No Finding Types"
                  description="Finding type distribution will appear after scans."
                />
              ) : (
                <div
                  role="region"
                  aria-label="Top finding types bar chart"
                  tabIndex={0}
                  className="h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
                >
                  <span className="sr-only">
                    Horizontal bar chart showing top finding types by occurrence frequency.
                  </span>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topFindingTypes} layout="vertical" accessibilityLayer>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis
                        type="number"
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        dataKey="type"
                        type="category"
                        width={120}
                        tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "rgba(0,0,0,0.8)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                      />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {topFindingTypes.map((_, index) => (
                          <Cell
                            key={`bar-${index}`}
                            fill={FINDING_TYPE_COLORS[index % FINDING_TYPE_COLORS.length]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Repository Comparison Table */}
          <Card className="glass-card">
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-3">
                <CardTitle className="text-sm font-bold">Repository Comparison</CardTitle>
                <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
                  {repoSummaries.length} Repositories
                </Badge>
              </div>
              {repoSummaries.length > 5 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAllRepos(!showAllRepos)}
                  className="text-xs font-mono text-muted-foreground hover:text-primary cursor-pointer"
                >
                  <Filter className="w-3.5 h-3.5 mr-1" />
                  {showAllRepos ? "Show Less" : `Show All (${repoSummaries.length})`}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {repoSummaries.length === 0 ? (
                <EmptyState
                  icon={<Shield className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />}
                  title="No Repositories"
                  description="Connect repositories to see scan comparison data."
                />
              ) : (
                <div className="space-y-2">
                  <div
                    className="flex items-center justify-end gap-1.5 text-[11px] font-mono text-muted-foreground sm:hidden px-1 pb-1"
                    data-testid="analytics-table-scroll-hint"
                  >
                    <span>Scroll table horizontally</span>
                    <span aria-hidden="true">&rarr;</span>
                  </div>
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label="Repository comparison table"
                    data-testid="analytics-table-container"
                    className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg border border-white/5"
                  >
                    <table
                      className="w-full text-sm min-w-[640px]"
                      aria-label="Repository Comparison"
                    >
                      <caption className="sr-only">
                        Security scan comparison across connected repositories
                      </caption>
                      <thead className="sticky top-0 bg-background/95 backdrop-blur z-10 border-b border-white/10">
                        <tr className="border-b border-white/10">
                          <th
                            scope="col"
                            className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Repository
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Scans
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Findings
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Critical
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            High
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Risk Score
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Pass Rate
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Last Scan
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRepos.map((repo) => (
                          <tr
                            key={repo.repositoryId}
                            className="border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                          >
                            <td className="py-3 px-4">
                              <span className="font-mono text-xs font-medium text-primary truncate max-w-[200px] block">
                                {repo.repositoryName}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right font-mono text-xs">
                              {repo.totalScans}
                            </td>
                            <td className="py-3 px-4 text-right font-mono text-xs">
                              {repo.totalFindings}
                            </td>
                            <td className="py-3 px-4 text-right">
                              <span
                                aria-label={`${repo.criticalFindings} critical findings`}
                                className={`inline-flex items-center gap-1 font-mono text-xs font-bold ${
                                  repo.criticalFindings > 0
                                    ? "text-red-700 dark:text-red-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {repo.criticalFindings > 0 && (
                                  <AlertOctagon className="w-3 h-3 shrink-0" aria-hidden="true" />
                                )}
                                <span>{repo.criticalFindings}</span>
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <span
                                aria-label={`${repo.highFindings} high findings`}
                                className={`inline-flex items-center gap-1 font-mono text-xs font-bold ${
                                  repo.highFindings > 0
                                    ? "text-orange-800 dark:text-orange-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                {repo.highFindings > 0 && (
                                  <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                )}
                                <span>{repo.highFindings}</span>
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right">
                              <RiskScoreBadge score={repo.averageRiskScore} />
                            </td>
                            <td className="py-3 px-4 text-right">
                              <PassRateBadge rate={repo.passRate} />
                            </td>
                            <td className="py-3 px-4 text-right text-xs text-muted-foreground">
                              {repo.lastScanAt ? (
                                <span className="flex items-center justify-end gap-1">
                                  <Clock className="w-3 h-3" />
                                  <TimeAgo date={repo.lastScanAt} />
                                </span>
                              ) : (
                                <span className="italic">Never</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Hotspots Tab Content */}
        <TabsContent
          value="hotspots"
          forceMount={activeTab === "hotspots" ? true : undefined}
          className={`space-y-6 mt-0 ${activeTab !== "hotspots" ? "hidden" : ""}`}
        >
          <Card className="glass-card">
            <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <CardTitle className="text-lg font-bold flex items-center gap-2">
                  <Folder className="w-5 h-5 text-primary" />
                  <span>Directory Hotspots</span>
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  Clusters of open findings by directory path prefix to prioritize remediation and
                  review efforts.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Repository Selector */}
                {hotspots.length > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground">Repo:</span>
                    <Select
                      value={selectedHotspotRepoId || hotspots[0]?.repositoryId || ""}
                      onValueChange={setSelectedHotspotRepoId}
                    >
                      <SelectTrigger
                        data-testid="hotspots-repo-select"
                        className="w-[180px] sm:w-[220px] h-9 text-xs"
                      >
                        <SelectValue placeholder="Select repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {hotspots.map((repo) => (
                          <SelectItem key={repo.repositoryId} value={repo.repositoryId}>
                            {repo.repositoryFullName} ({repo.totalOpenFindings})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Depth Selector */}
                <div className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 p-1">
                  <span className="text-xs font-mono text-muted-foreground px-2">Depth:</span>
                  {[1, 2, 3].map((depth) => (
                    <Button
                      key={depth}
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedDepth(depth)}
                      data-testid={`depth-btn-${depth}`}
                      className={`h-7 px-2.5 text-xs font-mono ${
                        selectedDepth === depth
                          ? "bg-primary/20 text-primary font-bold"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {depth}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>

            <CardContent>
              {!currentHotspotGroup ||
              currentHotspotGroup.totalOpenFindings === 0 ||
              currentHotspots.length === 0 ? (
                <div
                  data-testid="hotspots-empty-state"
                  className="flex flex-col items-center justify-center py-16 text-center"
                >
                  <Shield className="mb-4 h-12 w-12 text-emerald-400 opacity-60" />
                  <h3 className="text-lg font-bold">No Hotspots Found</h3>
                  <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                    This repository has no open security findings clustered in subdirectories.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label="Directory hotspots table"
                    data-testid="hotspots-table-container"
                    className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg border border-white/5"
                  >
                    <table className="w-full text-sm min-w-[640px]" aria-label="Directory Hotspots">
                      <caption className="sr-only">
                        Directory hotspots showing where open findings concentrate
                      </caption>
                      <thead className="sticky top-0 bg-background/95 backdrop-blur z-10 border-b border-white/10">
                        <tr className="border-b border-white/10">
                          <th
                            scope="col"
                            className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Directory Path
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Open Findings
                          </th>
                          <th
                            scope="col"
                            className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Severity Breakdown
                          </th>
                          <th
                            scope="col"
                            className="text-center py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Trend
                          </th>
                          <th
                            scope="col"
                            className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {currentHotspots.map((hotspot) => {
                          const findingsUrl = `/dashboard/findings?repo=${encodeURIComponent(
                            currentHotspotGroup.repositoryId,
                          )}&path=${encodeURIComponent(hotspot.pathPrefix)}`;

                          return (
                            <tr
                              key={hotspot.pathPrefix}
                              className="hover:bg-white/[0.02] transition-colors"
                            >
                              <td className="py-3 px-4 font-mono text-sm">
                                <Link
                                  href={findingsUrl}
                                  className="flex items-center gap-2 text-foreground hover:text-primary transition-colors group"
                                >
                                  <Folder className="w-4 h-4 text-primary shrink-0 group-hover:scale-110 transition-transform" />
                                  <span className="font-semibold underline-offset-4 group-hover:underline">
                                    {hotspot.directory}
                                  </span>
                                </Link>
                              </td>
                              <td className="py-3 px-4 text-right">
                                <Badge
                                  variant="outline"
                                  className="border-primary/30 bg-primary/10 text-primary font-mono text-xs font-bold"
                                >
                                  {hotspot.openCount}
                                </Badge>
                              </td>
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  {hotspot.severityCounts.CRITICAL > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                                      CRIT: {hotspot.severityCounts.CRITICAL}
                                    </span>
                                  )}
                                  {hotspot.severityCounts.HIGH > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-orange-500/15 text-orange-400 border border-orange-500/30">
                                      HIGH: {hotspot.severityCounts.HIGH}
                                    </span>
                                  )}
                                  {hotspot.severityCounts.MEDIUM > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-yellow-500/15 text-yellow-400 border border-yellow-500/30">
                                      MED: {hotspot.severityCounts.MEDIUM}
                                    </span>
                                  )}
                                  {hotspot.severityCounts.LOW > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-blue-500/15 text-blue-400 border border-blue-500/30">
                                      LOW: {hotspot.severityCounts.LOW}
                                    </span>
                                  )}
                                  {hotspot.severityCounts.INFO > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono font-bold bg-zinc-500/15 text-zinc-400 border border-zinc-500/30">
                                      INFO: {hotspot.severityCounts.INFO}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-3 px-4 text-center">
                                <div className="inline-flex items-center gap-1 font-mono text-xs">
                                  {hotspot.trend.direction === "up" ? (
                                    <>
                                      <TrendingUp className="w-3.5 h-3.5 text-red-400" />
                                      <span className="text-red-400 font-semibold">
                                        +{hotspot.trend.change}
                                      </span>
                                    </>
                                  ) : hotspot.trend.direction === "down" ? (
                                    <>
                                      <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
                                      <span className="text-emerald-400 font-semibold">
                                        {hotspot.trend.change}
                                      </span>
                                    </>
                                  ) : (
                                    <>
                                      <Minus className="w-3.5 h-3.5 text-muted-foreground" />
                                      <span className="text-muted-foreground">Stable</span>
                                    </>
                                  )}
                                </div>
                              </td>
                              <td className="py-3 px-4 text-right">
                                <Button
                                  asChild
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 text-xs font-mono text-primary hover:text-primary hover:bg-primary/10 gap-1"
                                >
                                  <Link href={findingsUrl}>
                                    <span>View findings</span>
                                    <ArrowRight className="w-3 h-3" />
                                  </Link>
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function SummaryCard({
  title,
  value,
  suffix,
  icon,
  color,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  icon: React.ReactNode;
  color: "primary" | "orange" | "green" | "blue";
}) {
  const borderColors = {
    primary: "border-primary/20",
    orange: "border-orange-500/20",
    green: "border-green-500/20",
    blue: "border-blue-500/20",
  };

  const bgColors = {
    primary: "bg-primary/10",
    orange: "bg-orange-500/10",
    green: "bg-green-500/10",
    blue: "bg-blue-500/10",
  };

  return (
    <Card
      className={`glass-card group overflow-hidden transition-all duration-300 hover:-translate-y-2 hover:shadow-2xl hover:border-primary/40 cursor-pointer ${borderColors[color]}`}
    >
      <CardContent className="relative p-6">
        <div className="absolute left-0 top-0 h-1 w-full bg-gradient-to-r from-primary via-violet-400 to-primary opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <div className="flex items-center justify-between mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
          <div
            className={`rounded-xl ${bgColors[color]} p-3 shadow-lg transition-all duration-300 group-hover:scale-110`}
          >
            {icon}
          </div>
        </div>
        <h3 className="text-5xl font-bold font-headline tracking-tight">
          {typeof value === "number" ? (
            <CountUp end={value} duration={1.2} />
          ) : (
            <span>{value}</span>
          )}
          {suffix && <span className="text-3xl text-muted-foreground">{suffix}</span>}
        </h3>
      </CardContent>
    </Card>
  );
}

function RiskScoreBadge({ score }: { score: number }) {
  let className = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  let Icon = CheckCircle2;
  if (score >= 70) {
    className = "bg-red-500/10 text-red-700 dark:text-red-300";
    Icon = AlertOctagon;
  } else if (score >= 40) {
    className = "bg-orange-500/10 text-orange-800 dark:text-orange-300";
    Icon = AlertTriangle;
  } else if (score >= 20) {
    className = "bg-amber-500/10 text-amber-800 dark:text-amber-300";
    Icon = AlertCircle;
  }

  return (
    <span
      role="status"
      aria-label={`Risk score: ${score}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold font-mono ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>{score}</span>
    </span>
  );
}

function PassRateBadge({ rate }: { rate: number }) {
  let className = "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  let Icon = CheckCircle2;
  if (rate < 50) {
    className = "bg-red-500/10 text-red-700 dark:text-red-300";
    Icon = AlertOctagon;
  } else if (rate < 80) {
    className = "bg-amber-500/10 text-amber-800 dark:text-amber-300";
    Icon = AlertTriangle;
  }

  return (
    <span
      role="status"
      aria-label={`Pass rate: ${rate}%`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold font-mono ${className}`}
    >
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span>{rate}%</span>
    </span>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center">
      {icon}
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 max-w-xs text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
