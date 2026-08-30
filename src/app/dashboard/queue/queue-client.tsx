"use client";

import React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Clock, Loader2, CheckCircle, XCircle, AlertTriangle, GitPullRequest } from "lucide-react";
import type { ScanJobRow, QueueStats } from "@/lib/actions/scan-jobs";

interface QueueClientProps {
  jobs: ScanJobRow[];
  stats: QueueStats;
  currentStatus: string;
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; badge: string }> = {
  PENDING: { icon: <Clock className="w-4 h-4" />, color: "text-yellow-400", badge: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400" },
  PROCESSING: { icon: <Loader2 className="w-4 h-4 animate-spin" />, color: "text-blue-400", badge: "bg-blue-500/10 border-blue-500/30 text-blue-400" },
  COMPLETED: { icon: <CheckCircle className="w-4 h-4" />, color: "text-green-400", badge: "bg-green-500/10 border-green-500/30 text-green-400" },
  FAILED: { icon: <XCircle className="w-4 h-4" />, color: "text-red-400", badge: "bg-red-500/10 border-red-500/30 text-red-400" },
};

const FILTER_TABS = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Running", value: "processing" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
];

function duration(start: Date | null, end: Date | null): string {
  if (!start) return "—";
  const ms = (end ?? Date.now()) - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatTile({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  return (
    <Card className="glass-card group overflow-hidden border border-foreground/10 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <div className="rounded-lg bg-primary/10 p-2">{icon}</div>
        </div>
        <p className={`text-3xl font-headline font-bold ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function JobRow({ job }: { job: ScanJobRow }) {
  const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.PENDING;
  const progress = job.totalFiles > 0 ? Math.round((job.scannedFiles / job.totalFiles) * 100) : 0;

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/[0.03] p-5 transition-all duration-300 hover:border-primary/30">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          {cfg.icon}
          <div className="min-w-0">
            <p className="text-sm font-bold truncate">{job.repoName}</p>
            {job.prNumber && (
              <div className="flex items-center gap-1.5 mt-0.5">
                <GitPullRequest className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-[11px] text-muted-foreground truncate">
                  #{job.prNumber} {job.prTitle ? `— ${job.prTitle}` : ""}
                </span>
              </div>
            )}
          </div>
        </div>
        <Badge className={`${cfg.badge} text-xs shrink-0`}>{job.status}</Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-muted-foreground">
        <div>
          <span className="block text-[10px] uppercase tracking-wider mb-1">Files</span>
          <span className="text-white font-bold">{job.scannedFiles}/{job.totalFiles}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wider mb-1">Findings</span>
          <span className="text-white font-bold">{job.vulnerabilitiesFound}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wider mb-1">Duration</span>
          <span className="text-white font-bold">{duration(job.startedAt, job.completedAt)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wider mb-1">Decision</span>
          <span className="text-white font-bold">{job.policyDecision ?? "—"}</span>
        </div>
      </div>

      {job.status === "PROCESSING" && job.totalFiles > 0 && (
        <Progress value={progress} className="mt-3 h-1.5" />
      )}

      {job.error && (
        <div className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400 font-mono truncate">
          {job.error}
        </div>
      )}
    </div>
  );
}

export default function QueueClient({ jobs, stats, currentStatus }: QueueClientProps) {
  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">Operations</span>
        <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">Scan Queue</h1>
        <p className="mt-2 max-w-xl text-muted-foreground">Monitor pending, running, and completed security scan jobs.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
        <StatTile label="Pending" value={stats.pending} icon={<Clock className="w-4 h-4 text-yellow-400" />} color="text-yellow-400" />
        <StatTile label="Running" value={stats.processing} icon={<Loader2 className="w-4 h-4 text-blue-400" />} color="text-blue-400" />
        <StatTile label="Completed" value={stats.completed} icon={<CheckCircle className="w-4 h-4 text-green-400" />} color="text-green-400" />
        <StatTile label="Failed" value={stats.failed} icon={<AlertTriangle className="w-4 h-4 text-red-400" />} color="text-red-400" />
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <Link
            key={tab.value}
            href={`/dashboard/queue?status=${tab.value}`}
            className={`px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wider transition-all ${
              currentStatus === tab.value
                ? "bg-primary/10 text-primary border border-primary/30"
                : "text-muted-foreground hover:text-white border border-white/5 hover:border-white/20"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      {/* Job List */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-lg font-bold">Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <CheckCircle className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold">No Jobs Found</h3>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                Scan jobs will appear here when pull requests trigger automated security scans.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
