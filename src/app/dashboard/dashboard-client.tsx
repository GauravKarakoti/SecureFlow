"use client";

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
  const totalFindings = distribution.critical + distribution.high + distribution.medium + distribution.low || 1;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-1">Risk Overview</h1>
          <p className="text-muted-foreground">Monitoring active repositories across the organization.</p>
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
          <CardHeader>
            <CardTitle className="text-sm font-bold flex items-center justify-between">Scan Activity</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <Area type="monotone" dataKey="scans" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#colorScans)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Dynamic Severity Distribution */}
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-sm font-bold">Severity Distribution</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-6">
            <DistributionRow label="Critical" count={distribution.critical} total={totalFindings} color="bg-red-500" />
            <DistributionRow label="High" count={distribution.high} total={totalFindings} color="bg-orange-500" />
            <DistributionRow label="Medium" count={distribution.medium} total={totalFindings} color="bg-yellow-500" />
            <DistributionRow label="Low" count={distribution.low} total={totalFindings} color="bg-blue-500" />
          </CardContent>
        </Card>
      </div>

      {/* Recent PRs Table */}
      <Card className="glass-card">
        <CardHeader className="pb-4"><CardTitle className="text-lg font-bold">Recent Pull Requests</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            {prs.map((pr) => (
              <div key={pr.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 rounded-xl bg-white/5 border border-white/10">
                <div className="flex items-start sm:items-center gap-3">
                  <GitPullRequest className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5 sm:mt-0" />
                  <div className="min-w-0">
                    <div className="font-bold text-sm mb-1 flex flex-wrap items-center gap-2">
                      <span className="truncate">{pr.title}</span>
                      <Badge variant="secondary" className="text-[10px] py-0 shrink-0">#{pr.prNumber}</Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-2">
                      <span>{new Date(pr.createdAt).toLocaleDateString()}</span>
                      <span className="text-primary truncate max-w-[180px] sm:max-w-none">{pr.repository.fullName}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center pl-8 sm:pl-0">
                  <span className={`text-xs font-bold ${pr.status === 'BLOCKED' ? 'text-red-400' : pr.status === 'PASS' ? 'text-green-400' : 'text-yellow-400'}`}>
                    {pr.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, icon }: { title: string, value: number, icon: React.ReactNode }) {
  return (
    <Card className="glass-card overflow-hidden group">
      <CardContent className="p-6">
        <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">{title}</p>
        <div className="flex items-baseline gap-2">
          <h3 className="text-3xl font-bold font-headline">{value}</h3>
        </div>
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