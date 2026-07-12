"use client";

import CountUp from "react-countup";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldAlert, GitPullRequest, CheckCircle, AlertTriangle, Zap } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { Badge } from "@/components/ui/badge";

// Optional: define types based on your Prisma schema
interface DashboardClientProps {
  stats: { totalScans: number; blockedPRs: number; approvedPRs: number; secretsDetected: number };
  prs: any[]; // Replace with proper Prisma type if available
  chartData: any[];
  distribution: { critical: number; high: number; medium: number; low: number };
}

export default function DashboardClient({ stats, prs, chartData, distribution }: DashboardClientProps) {
 const totalFindings =
  distribution.critical +
  distribution.high +
  distribution.medium +
  distribution.low;

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
       <div>
  <span className="text-sm font-medium uppercase tracking-widest text-primary">
    Dashboard
  </span>

  <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
    Risk Overview
  </h1>

  <p className="mt-2 max-w-xl text-muted-foreground">
    Monitor repository security, scan activity, and pull request health from one place.
  </p>

  <div className="mt-4 flex items-center gap-2">
    <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
    <span className="text-xs font-medium text-muted-foreground">
      SecureFlow monitoring active
    </span>
  </div>
</div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Total Scans" value={stats.totalScans} icon={<Zap className="w-5 h-5 text-primary" />} />
        <StatCard title="Blocked PRs" value={stats.blockedPRs} icon={<AlertTriangle className="w-5 h-5 text-red-400" />} />
        <StatCard title="Approved PRs" value={stats.approvedPRs} icon={<CheckCircle className="w-5 h-5 text-green-400" />} />
        <StatCard title="Secrets Detected" value={stats.secretsDetected} icon={<ShieldAlert className="w-5 h-5 text-orange-400" />} />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">

        <Card className="lg:col-span-2 glass-card">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-bold">
              Scan Activity
            </CardTitle>

            <Badge
              variant="outline"
              className="border-primary/20 bg-primary/5 text-primary"
            >
              Last 30 Days
            </Badge>
          </CardHeader>

          <CardContent className="h-[300px]">
            {chartData.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-white/10 text-center">
                <Zap className="mb-4 h-12 w-12 text-primary opacity-60" />

                <h3 className="text-lg font-semibold">
                  No Scan Activity
                </h3>

                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  Run your first repository scan to start visualizing scan activity over time.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorScans" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>

                  <Area
                    type="monotone"
                    dataKey="scans"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    fill="url(#colorScans)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Dynamic Severity Distribution */}
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-sm font-bold">Severity Distribution</CardTitle></CardHeader>
          <CardContent>
  {totalFindings === 0 ? (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <ShieldAlert className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />

      <h3 className="text-lg font-semibold">
        No Security Findings
      </h3>

      <p className="mt-2 max-w-xs text-sm text-muted-foreground">
        Severity metrics will appear after your first successful scan.
      </p>
    </div>
  ) : (
    <div className="flex flex-col gap-6">
      <DistributionRow
        label="Critical"
        count={distribution.critical}
        total={totalFindings}
        color="bg-red-500"
      />

      <DistributionRow
        label="High"
        count={distribution.high}
        total={totalFindings}
        color="bg-orange-500"
      />

      <DistributionRow
        label="Medium"
        count={distribution.medium}
        total={totalFindings}
        color="bg-yellow-500"
      />

      <DistributionRow
        label="Low"
        count={distribution.low}
        total={totalFindings}
        color="bg-blue-500"
      />
    </div>
  )}
</CardContent>
        </Card>
      </div>

      {/* Recent PRs Table */}
      <Card className="glass-card">
        <CardHeader className="pb-4"><CardTitle className="text-lg font-bold">Recent Pull Requests</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            {prs.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-14 text-center">
                <GitPullRequest className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />

                <h3 className="text-lg font-semibold">
                  No Pull Requests Yet
                </h3>

                <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                  Connect a repository and run a scan to view pull requests,
                  security findings, and policy results here.
                </p>
              </div>
            ) : (
              prs.map((pr) => (
                <div
                  key={pr.id}
                  className="group flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-4 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:bg-white/10 hover:shadow-lg"
                >
                  <div className="flex items-start sm:items-center gap-3">
                    <GitPullRequest className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground sm:mt-0" />

                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-sm font-bold">
                        <span className="truncate">
                          {pr.title}
                        </span>

                        <Badge
                          variant="secondary"
                          className="shrink-0 py-0 text-[10px]"
                        >
                          #{pr.prNumber}
                        </Badge>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                        <span suppressHydrationWarning>
                          {new Date(pr.createdAt).toLocaleDateString('en-GB')}
                        </span>

                        <span className="max-w-[180px] truncate text-primary sm:max-w-none">
                          {pr.repository.fullName}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center pl-8 sm:pl-0">
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        pr.status === "BLOCKED"
                          ? "bg-red-500/20 text-red-300"
                          : pr.status === "PASS"
                          ? "bg-green-500/20 text-green-300"
                          : "bg-yellow-500/20 text-yellow-300"
                      }`}
                    >
                      {pr.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
     <Card className="
glass-card
group
overflow-hidden
border
border-white/10
transition-all
duration-300
hover:-translate-y-1
hover:border-primary/40
hover:shadow-[0_0_35px_rgba(139,92,246,0.15)]
">
      <CardContent className="relative p-6">
        <div className="absolute left-0 top-0 h-1 w-full bg-gradient-to-r from-primary via-violet-400 to-primary opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <div className="flex items-center justify-between mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </p>
<div className="rounded-xl bg-primary/10 p-3 shadow-lg shadow-primary/10 transition-all duration-300 group-hover:scale-110 group-hover:bg-primary/20">
          
            {icon}
          </div>
        </div>

        <h3 className="text-5xl font-bold font-headline tracking-tight">
          <CountUp
end={value}
duration={1.2}
/>
        </h3>
      </CardContent>
    </Card>
  );
}

function DistributionRow({ label, count, total, color }: { label: string, count: number, total: number, color: string }) {
  const percentage = Math.max(2, Math.round((count / total) * 100));
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-32 bg-white/5 rounded-full overflow-hidden">
          <div className={`h-full ${color}`} style={{ width: `${percentage}%` }} />
        </div>
        <span className="text-xs font-bold w-6">{count}</span>
      </div>
    </div>
  );
}