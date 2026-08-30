"use client";

import React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FolderGit2,
  GitPullRequest,
  ShieldAlert,
  Clock,
  CheckCircle,
  AlertTriangle,
  Search,
} from "lucide-react";
import type { RepoOverview } from "@/lib/actions/repositories";

interface ReposClientProps {
  repos: RepoOverview[];
}

const RISK_STYLES: Record<RepoOverview["riskLevel"], { badge: string; dot: string; label: string }> = {
  none:     { badge: "bg-green-500/10 border-green-500/30 text-green-400",  dot: "bg-green-400",  label: "Clean" },
  low:      { badge: "bg-blue-500/10 border-blue-500/30 text-blue-400",    dot: "bg-blue-400",   label: "Low Risk" },
  medium:   { badge: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400", dot: "bg-yellow-400", label: "Medium" },
  high:     { badge: "bg-orange-500/10 border-orange-500/30 text-orange-400", dot: "bg-orange-400", label: "High Risk" },
  critical: { badge: "bg-red-500/10 border-red-500/30 text-red-400",       dot: "bg-red-400",    label: "Critical" },
};

function RepoCard({ repo }: { repo: RepoOverview }) {
  const risk = RISK_STYLES[repo.riskLevel];
  const ago = repo.lastScanAt
    ? formatAgo(new Date(repo.lastScanAt))
    : "Never scanned";

  return (
    <Link href={`/dashboard/findings?repo=${repo.id}`}>
      <Card className="glass-card group overflow-hidden border border-foreground/10 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-[0_0_35px_rgba(139,92,246,0.15)] cursor-pointer h-full">
        <CardContent className="p-6 flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="rounded-xl bg-primary/10 p-2.5 shrink-0">
                <FolderGit2 className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{repo.fullName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`w-2 h-2 rounded-full ${repo.isActive ? "bg-green-400" : "bg-zinc-500"}`} />
                  <span className="text-[10px] text-muted-foreground">{repo.isActive ? "Active" : "Paused"}</span>
                </div>
              </div>
            </div>
            <Badge className={`${risk.badge} text-[10px] shrink-0`}>{risk.label}</Badge>
          </div>

          {/* Metrics */}
          <div className="grid grid-cols-3 gap-3">
            <MetricCell icon={<GitPullRequest className="w-3.5 h-3.5" />} label="PRs" value={repo.prCount} />
            <MetricCell icon={<ShieldAlert className="w-3.5 h-3.5" />} label="Findings" value={repo.openFindings} highlight={repo.openFindings > 0} />
            <MetricCell icon={<CheckCircle className="w-3.5 h-3.5" />} label="Scans" value={repo.scanCount} />
          </div>

          {/* Footer */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-1 border-t border-white/5">
            <Clock className="w-3 h-3 shrink-0" />
            <span>Last scan: {ago}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function MetricCell({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg bg-foreground/[0.04] p-3 text-center">
      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
        {icon}
        <span className="text-[9px] uppercase tracking-wider">{label}</span>
      </div>
      <p className={`text-lg font-headline font-bold ${highlight ? "text-orange-400" : ""}`}>{value}</p>
    </div>
  );
}

function formatAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function ReposClient({ repos }: ReposClientProps) {
  const active = repos.filter((r) => r.isActive);
  const paused = repos.filter((r) => !r.isActive);

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-sm font-medium uppercase tracking-widest text-primary">Assets</span>
          <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">Repositories</h1>
          <p className="mt-2 max-w-xl text-muted-foreground">
            Security posture overview for all connected repositories.
          </p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-sm border border-white/10 bg-white/5 text-xs text-muted-foreground">
          <Search className="w-3.5 h-3.5" />
          <span>{repos.length} total · {active.length} active</span>
        </div>
      </div>

      {repos.length === 0 ? (
        <Card className="glass-card">
          <CardContent className="py-20 flex flex-col items-center justify-center text-center">
            <FolderGit2 className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
            <h3 className="text-lg font-semibold">No Repositories Connected</h3>
            <p className="mt-2 max-w-sm text-sm text-muted-foreground">
              Install the SecureFlow GitHub App to start monitoring your repositories.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Active Repos */}
          {active.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Active ({active.length})
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {active.map((repo) => (
                  <RepoCard key={repo.id} repo={repo} />
                ))}
              </div>
            </section>
          )}

          {/* Paused Repos */}
          {paused.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Paused ({paused.length})
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {paused.map((repo) => (
                  <RepoCard key={repo.id} repo={repo} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
