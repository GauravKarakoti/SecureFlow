"use client";

import React, { useState, useCallback, useMemo } from "react";
import CountUp from "react-countup";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  AlertTriangle,
  Clock,
  Filter,
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
}

interface AnalyticsClientProps {
  dailyMetrics: DailyScanMetric[];
  severityTrend: SeverityTrendPoint[];
  repoSummaries: RepoScanSummary[];
  topFindingTypes: TopFindingType[];
  scanVelocity: ScanVelocity[];
  summary: AnalyticsSummary;
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
  dailyMetrics,
  severityTrend,
  repoSummaries,
  topFindingTypes,
  scanVelocity,
  summary,
}: AnalyticsClientProps) {
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [exporting, setExporting] = useState(false);

  const visibleRepos = useMemo(
    () => (showAllRepos ? repoSummaries : repoSummaries.slice(0, 5)),
    [showAllRepos, repoSummaries]
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
      link.download = `secureflow-analytics-${new Date().toISOString().split("T")[0]}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [summary, dailyMetrics, severityTrend, repoSummaries, topFindingTypes]);

  const pieData = useMemo(
    () =>
      topFindingTypes.map((ft) => ({
        name: ft.type,
        value: ft.count,
      })),
    [topFindingTypes]
  );

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
            Deep dive into scan history, finding trends, and repository security posture over time.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {TREND_ICONS[summary.trendDirection]}
              <span className="text-xs font-medium text-muted-foreground">
                {TREND_LABELS[summary.trendDirection]}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCSV}
            disabled={exporting}
            className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer font-mono text-xs"
          >
            <Download className="w-3.5 h-3.5 mr-2" />
            Export CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportJSON}
            disabled={exporting}
            className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer font-mono text-xs"
          >
            <Download className="w-3.5 h-3.5 mr-2" />
            Export JSON
          </Button>
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
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
      </div>

      {/* Scan Activity + Scan Velocity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
        <Card className="lg:col-span-2 glass-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-bold">Scan Activity & Findings</CardTitle>
            <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
              Last 30 Days
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
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyMetrics}>
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
                <div className="flex-1 min-h-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
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
                          backgroundColor:
                            FINDING_TYPE_COLORS[i % FINDING_TYPE_COLORS.length],
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
          {severityTrend.length === 0 || severityTrend.every(
            (s) => s.critical + s.high + s.medium + s.low === 0
          ) ? (
            <EmptyState
              icon={<BarChart3 className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />}
              title="No Severity Data"
              description="Severity distribution trends will appear after scans produce findings."
            />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={severityTrend}>
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
                <Bar dataKey="critical" name="Critical" stackId="a" fill={SEVERITY_COLORS.critical} />
                <Bar dataKey="high" name="High" stackId="a" fill={SEVERITY_COLORS.high} />
                <Bar dataKey="medium" name="Medium" stackId="a" fill={SEVERITY_COLORS.medium} />
                <Bar dataKey="low" name="Low" stackId="a" fill={SEVERITY_COLORS.low} />
              </BarChart>
            </ResponsiveContainer>
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
              icon={<AlertTriangle className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />}
              title="No Finding Types"
              description="Finding type distribution will appear after scans."
            />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={topFindingTypes} layout="vertical">
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
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Repository
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Scans
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Findings
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Critical
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      High
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Risk Score
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Pass Rate
                    </th>
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                          className={`font-mono text-xs font-bold ${
                            repo.criticalFindings > 0 ? "text-red-400" : "text-muted-foreground"
                          }`}
                        >
                          {repo.criticalFindings}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <span
                          className={`font-mono text-xs font-bold ${
                            repo.highFindings > 0 ? "text-orange-400" : "text-muted-foreground"
                          }`}
                        >
                          {repo.highFindings}
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
                            <span suppressHydrationWarning>
                              {new Date(repo.lastScanAt).toLocaleDateString("en-GB")}
                            </span>
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
          )}
        </CardContent>
      </Card>
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
  value: number;
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
          <CountUp end={value} duration={1.2} />
          {suffix && (
            <span className="text-3xl text-muted-foreground">{suffix}</span>
          )}
        </h3>
      </CardContent>
    </Card>
  );
}

function RiskScoreBadge({ score }: { score: number }) {
  let className = "bg-green-500/10 text-green-400";
  if (score >= 70) className = "bg-red-500/10 text-red-400";
  else if (score >= 40) className = "bg-orange-500/10 text-orange-400";
  else if (score >= 20) className = "bg-yellow-500/10 text-yellow-400";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold font-mono ${className}`}
    >
      {score}
    </span>
  );
}

function PassRateBadge({ rate }: { rate: number }) {
  let className = "bg-green-500/10 text-green-400";
  if (rate < 50) className = "bg-red-500/10 text-red-400";
  else if (rate < 80) className = "bg-yellow-500/10 text-yellow-400";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold font-mono ${className}`}
    >
      {rate}%
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
