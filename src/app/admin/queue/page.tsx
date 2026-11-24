import { getQueueMetrics, getDLQJobs } from "@/lib/actions/queue";
import {
  Activity,
  CheckCircle,
  Clock,
  AlertTriangle,
  AlertOctagon,
  ShieldAlert,
} from "lucide-react";
import DLQTable from "@/components/admin/DLQTable";
import JobExplorer from "@/components/admin/JobExplorer";

export const dynamic = "force-dynamic";

export default async function QueueMonitorPage() {
  const metrics = await getQueueMetrics();
  const dlqJobs = await getDLQJobs();

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight text-white">Queue Monitor</h1>
        <p className="text-muted-foreground">
          Real-time observability of the BullMQ async processing pipelines and Dead-Letter Queue.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
        {/* Waiting Card */}
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-zinc-500/50 hover:shadow-[0_0_25px_rgba(255,255,255,0.05)]">
          <div className="absolute top-0 left-0 w-0 h-[2px] bg-zinc-500 group-hover:w-full transition-all duration-500" />
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-zinc-300 transition-colors">
              Waiting
            </h3>
            <Clock className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="text-3xl font-black font-headline text-white">{metrics.waiting}</div>
        </div>

        {/* Active Card */}
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-blue-500/50 hover:shadow-[0_0_25px_rgba(59,130,246,0.15)]">
          <div className="absolute top-0 left-0 w-0 h-[2px] bg-blue-500 group-hover:w-full transition-all duration-500" />
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-blue-400 transition-colors">
              Active
            </h3>
            <Activity className="w-4 h-4 text-blue-500 animate-pulse" />
          </div>
          <div className="text-3xl font-black font-headline text-white">{metrics.active}</div>
        </div>

        {/* Completed Card */}
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-emerald-500/50 hover:shadow-[0_0_25px_rgba(16,185,129,0.15)]">
          <div className="absolute top-0 left-0 w-0 h-[2px] bg-emerald-500 group-hover:w-full transition-all duration-500" />
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-emerald-400 transition-colors">
              Completed
            </h3>
            <CheckCircle className="w-4 h-4 text-emerald-500" />
          </div>
          <div className="text-3xl font-black font-headline text-white">{metrics.completed}</div>
        </div>

        {/* Failed Card */}
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-red-500/50 hover:shadow-[0_0_25px_rgba(239,68,68,0.15)]">
          <div className="absolute top-0 left-0 w-0 h-[2px] bg-red-500 group-hover:w-full transition-all duration-500" />
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-red-400 transition-colors">
              Failed (DLQ)
            </h3>
            <AlertTriangle className="w-4 h-4 text-red-500" />
          </div>
          <div className="text-3xl font-black font-headline text-white">{metrics.failed}</div>
        </div>

        {/* Delayed Card */}
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 transition-all duration-500 hover:-translate-y-1.5 hover:border-yellow-500/50 hover:shadow-[0_0_25px_rgba(245,158,11,0.15)]">
          <div className="absolute top-0 left-0 w-0 h-[2px] bg-yellow-500 group-hover:w-full transition-all duration-500" />
          <div className="flex items-center justify-between pb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-yellow-400 transition-colors">
              Delayed
            </h3>
            <AlertOctagon className="w-4 h-4 text-yellow-500" />
          </div>
          <div className="text-3xl font-black font-headline text-white">{metrics.delayed}</div>
        </div>
      </div>

      {/* Queue Details Section */}
      <div className="glass-card border border-white/10 rounded-xl p-6 relative overflow-hidden">
        <div className="absolute -right-20 -bottom-20 w-80 h-80 bg-red-500/5 rounded-full blur-3xl pointer-events-none" />
        <h2 className="text-xl font-bold font-headline mb-4 flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-primary" />
          Queue Health and Operations
        </h2>
        <div className="grid md:grid-cols-2 gap-6 text-sm text-zinc-400 leading-relaxed">
          <div className="space-y-3">
            <p>
              The system processes security evaluations asynchronously using BullMQ backed by a
              high-throughput Redis instance. Each scan verifies if passwords, secrets, or
              vulnerable dependencies are being committed.
            </p>
            <p>
              If a scan job fails, it automatically enters the Dead-Letter Queue (DLQ) for retries
              or manual diagnostics. The monitoring interface updates in real-time to report
              pipeline anomalies.
            </p>
          </div>
          <div className="space-y-4">
            <div className="flex justify-between items-center border-b border-white/5 pb-2">
              <span>Auto-Retry System</span>
              <span className="text-emerald-400 font-bold uppercase text-xs tracking-wider">
                Active (3 retries)
              </span>
            </div>
            <div className="flex justify-between items-center border-b border-white/5 pb-2">
              <span>Dead-Letter Storage Limit</span>
              <span className="text-white font-mono text-xs">10,000 entries max</span>
            </div>
            <div className="flex justify-between items-center">
              <span>Worker Node Status</span>
              <span className="flex items-center gap-1.5 text-emerald-400 font-bold text-xs tracking-wider uppercase">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Operational
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Per-Installation Fairness & Queue Depth Section (#1980) */}
      <div className="glass-card border border-white/10 rounded-xl p-6 relative overflow-hidden">
        <h2 className="text-xl font-bold font-headline mb-2 flex items-center gap-2">
          <Activity className="w-5 h-5 text-blue-400" />
          Per-Installation Queue Fairness
        </h2>
        <p className="text-sm text-zinc-400 mb-4">
          Round-robin fair scheduling with a limit of{" "}
          <span className="font-semibold text-white">
            {metrics.installationConcurrencyLimit ?? 2} concurrent scans per installation
          </span>
          . Prevents large PR floods from starving small repositories.
        </p>

        {Object.keys(metrics.queueDepthPerInstallation || {}).length === 0 &&
        Object.keys(metrics.activePerInstallation || {}).length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            No installations currently active or queued.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-300">
              <thead className="text-xs uppercase bg-white/5 text-zinc-400 border-b border-white/10">
                <tr>
                  <th className="py-2.5 px-4 font-semibold">Installation ID</th>
                  <th className="py-2.5 px-4 font-semibold">Waiting Queue Depth</th>
                  <th className="py-2.5 px-4 font-semibold">Active Scans</th>
                  <th className="py-2.5 px-4 font-semibold">Concurrency Limit</th>
                  <th className="py-2.5 px-4 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 font-mono text-xs">
                {Array.from(
                  new Set([
                    ...Object.keys(metrics.queueDepthPerInstallation || {}),
                    ...Object.keys(metrics.activePerInstallation || {}),
                  ]),
                ).map((instId) => {
                  const depth = metrics.queueDepthPerInstallation?.[instId] ?? 0;
                  const active = metrics.activePerInstallation?.[instId] ?? 0;
                  const limit = metrics.installationConcurrencyLimit ?? 2;
                  const isAtLimit = active >= limit;

                  return (
                    <tr key={instId} className="hover:bg-white/5 transition-colors">
                      <td className="py-2 px-4 text-white font-medium">{instId}</td>
                      <td className="py-2 px-4">{depth}</td>
                      <td className="py-2 px-4">{active}</td>
                      <td className="py-2 px-4">{limit}</td>
                      <td className="py-2 px-4">
                        {isAtLimit ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            At Concurrency Limit
                          </span>
                        ) : active > 0 ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-500/20 text-zinc-400 border border-zinc-500/30">
                            Waiting
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 mt-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-bold tracking-tight">Pipeline Jobs</h2>
          <p className="text-sm text-muted-foreground">
            Drill into individual jobs across the Waiting, Active, Completed, and Delayed states.
          </p>
        </div>
        <JobExplorer />
      </div>

      <div className="flex flex-col gap-4 mt-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-bold tracking-tight">Dead-Letter Queue (DLQ)</h2>
          <p className="text-sm text-muted-foreground">
            Review and recover jobs that permanently failed after exceeding maximum retries.
          </p>
        </div>
        <DLQTable initialJobs={dlqJobs} />
      </div>
    </div>
  );
}
