import {
  getAuditLogs,
  getAuditLogMetrics,
  getAuditLogFilters,
} from "@/lib/actions/admin";
import LogsTable from "@/components/admin/LogsTable";
import MetricsCard from "@/components/admin/MetricsCard";
import { ScrollText } from "lucide-react";

export const metadata = {
  title: "Audit Logs · SecureFlow Admin",
};

// A generous first batch keeps the table instantly filterable client-side;
// the underlying server action supports full pagination for larger datasets.
const INITIAL_PAGE_SIZE = 200;

export default async function AdminLogsPage() {
  const [result, metrics, filters] = await Promise.all([
    getAuditLogs({ page: 1, pageSize: INITIAL_PAGE_SIZE }),
    getAuditLogMetrics(),
    getAuditLogFilters(),
  ]);

  const topAction = metrics.topActions[0];

  return (
    <div className="space-y-8">
      <header className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0">
          <ScrollText className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Audit Logs
          </h1>
          <p className="text-zinc-400 mt-2">
            Comprehensive audit trail of every administrative and system event.
          </p>
        </div>
      </header>

      <div className="grid gap-6 sm:grid-cols-3">
        <MetricsCard title="Total Logs" value={metrics.total} />
        <MetricsCard title="Last 24 Hours" value={metrics.last24h} />
        <MetricsCard
          title="Top Action"
          value={topAction ? `${topAction.action}` : "—"}
        />
      </div>

      <LogsTable logs={result.logs} actions={filters.actions} />

      {result.total > INITIAL_PAGE_SIZE && (
        <p className="text-xs text-zinc-500 text-center">
          Showing the most recent {result.logs.length} of {result.total} log
          entries. Use the server action&apos;s pagination parameters for full
          history access.
        </p>
      )}
    </div>
  );
}
