import { getAdminMetrics, getRecentAuditLogs } from "@/lib/actions/admin";
import MetricsCard from "@/components/admin/MetricsCard";
import AuditLogTable from "@/components/admin/AuditLogTable";

export default async function AdminDashboard() {
  const metrics = await getAdminMetrics();
  const logs = await getRecentAuditLogs();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Dashboard Overview</h1>
        <p className="text-zinc-400 mt-2">System-wide metrics and administrative analytics.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <MetricsCard title="Total Users" value={metrics.totalUsers} />
        <MetricsCard title="Pull Requests Scanned" value={metrics.totalPrs} />
        <MetricsCard title="Audit Logs" value={metrics.totalAudits} />
      </div>

      <div className="mt-8">
        <h2 className="text-2xl font-semibold mb-4">Recent Audit Activity</h2>
        <AuditLogTable logs={logs} />
      </div>
    </div>
  );
}
