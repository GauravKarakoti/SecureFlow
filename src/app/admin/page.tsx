import { getAdminMetrics, getRecentAuditLogs } from "@/lib/actions/admin";
import MetricsCard from "@/components/admin/MetricsCard";
import AuditLogTable from "@/components/admin/AuditLogTable";
import { Users, GitPullRequest, History } from "lucide-react";

export default async function AdminDashboard() {
  const metrics = await getAdminMetrics();
  const logs = await getRecentAuditLogs();

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">
          Admin Panel
        </span>
        <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
          Dashboard Overview
        </h1>
        <p className="mt-2 max-w-xl text-muted-foreground">
          System-wide metrics and administrative analytics.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <MetricsCard
          title="Total Users"
          value={metrics.totalUsers}
          icon={<Users className="w-5 h-5 text-primary" />}
        />
        <MetricsCard
          title="Pull Requests Scanned"
          value={metrics.totalPrs}
          icon={<GitPullRequest className="w-5 h-5 text-primary" />}
        />
        <MetricsCard
          title="Audit Logs"
          value={metrics.totalAudits}
          icon={<History className="w-5 h-5 text-primary" />}
        />
      </div>

      <div>
        <h2 className="font-headline text-2xl font-semibold mb-4 tracking-tight">
          Recent Audit Activity
        </h2>
        <AuditLogTable logs={logs} />
      </div>
    </div>
  );
}
