"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { ShieldCheck, TrendingUp, Target, AlertTriangle, Trophy } from "lucide-react";
import type { RepoSecurityScore, ScoreBand } from "@/lib/security-score";

interface AnalyticsClientProps {
  globalScore: number;
  globalBand: ScoreBand;
  repoScores: RepoSecurityScore[];
  trendData: { date: string; score: number }[];
}

const BAND_COLORS: Record<ScoreBand, string> = {
  Fortress: "text-green-400",
  Guarded: "text-blue-400",
  Exposed: "text-yellow-400",
  Breached: "text-red-400",
};

const BAND_BG: Record<ScoreBand, string> = {
  Fortress: "bg-green-500/10 border-green-500/30",
  Guarded: "bg-blue-500/10 border-blue-500/30",
  Exposed: "bg-yellow-500/10 border-yellow-500/30",
  Breached: "bg-red-500/10 border-red-500/30",
};

function ScoreGauge({ score, band }: { score: number; band: ScoreBand }) {
  return (
    <Card className="glass-card overflow-hidden">
      <CardContent className="p-8 flex flex-col items-center gap-4">
        <div className="relative w-40 h-40">
          <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
            <circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="8" className="text-white/5" />
            <circle
              cx="60" cy="60" r="50" fill="none" stroke="currentColor" strokeWidth="8"
              strokeLinecap="round" strokeDasharray={`${(score / 100) * 314} 314`}
              className={BAND_COLORS[band]}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-4xl font-headline font-extrabold">{score}</span>
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">/ 100</span>
          </div>
        </div>
        <Badge className={`${BAND_BG[band]} ${BAND_COLORS[band]} text-xs`}>{band}</Badge>
      </CardContent>
    </Card>
  );
}

function TrendChart({ data }: { data: { date: string; score: number }[] }) {
  if (data.length === 0) {
    return (
      <Card className="glass-card">
        <CardHeader><CardTitle className="text-sm font-bold">Score Trend (30 Days)</CardTitle></CardHeader>
        <CardContent className="h-[200px] flex items-center justify-center">
          <p className="text-xs text-muted-foreground">No scan data yet.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="glass-card">
      <CardHeader><CardTitle className="text-sm font-bold">Score Trend (30 Days)</CardTitle></CardHeader>
      <CardContent className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="scoreGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="score" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#scoreGrad)" />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function MetricTile({ title, value, icon }: { title: string; value: number; icon: React.ReactNode }) {
  return (
    <Card className="glass-card group overflow-hidden border border-foreground/10 transition-all duration-300 hover:-translate-y-1 hover:border-primary/40">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
          <div className="rounded-lg bg-primary/10 p-2">{icon}</div>
        </div>
        <p className="text-3xl font-headline font-bold">{value}</p>
        <Progress value={Math.min(value, 100)} className="mt-3 h-1.5" />
      </CardContent>
    </Card>
  );
}

function LeaderboardRow({ rank, repo }: { rank: number; repo: RepoSecurityScore }) {
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
  return (
    <div className="flex items-center justify-between rounded-xl border border-foreground/10 bg-foreground/[0.03] p-4 transition-all duration-300 hover:border-primary/30">
      <div className="flex items-center gap-4 min-w-0">
        <span className="text-lg w-8 text-center shrink-0">{medal}</span>
        <div className="min-w-0">
          <p className="text-sm font-bold truncate">{repo.repoName}</p>
          <p className="text-[10px] text-muted-foreground">{repo.totalFindings} findings · {repo.scanCount} scans</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-xs text-muted-foreground">{repo.resolvedFindings}/{repo.totalFindings} resolved</span>
        <Badge className={`${BAND_BG[repo.band]} ${BAND_COLORS[repo.band]}`}>{repo.score}</Badge>
      </div>
    </div>
  );
}

export default function AnalyticsClient({ globalScore, globalBand, repoScores, trendData }: AnalyticsClientProps) {
  const totalFindings = repoScores.reduce((s, r) => s + r.totalFindings, 0);
  const totalResolved = repoScores.reduce((s, r) => s + r.resolvedFindings, 0);
  const totalScans = repoScores.reduce((s, r) => s + r.scanCount, 0);
  const avgSev = repoScores.length
    ? Math.round(repoScores.reduce((s, r) => s + r.breakdown.severityScore, 0) / repoScores.length)
    : 0;

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">Analytics</span>
        <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">Security Posture</h1>
        <p className="mt-2 max-w-xl text-muted-foreground">Aggregate security scores across all monitored repositories.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ScoreGauge score={globalScore} band={globalBand} />
        <div className="lg:col-span-2">
          <TrendChart data={trendData} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <MetricTile title="Total Findings" value={totalFindings} icon={<AlertTriangle className="w-4 h-4 text-orange-400" />} />
        <MetricTile title="Resolved" value={totalResolved} icon={<ShieldCheck className="w-4 h-4 text-green-400" />} />
        <MetricTile title="Total Scans" value={totalScans} icon={<Target className="w-4 h-4 text-primary" />} />
        <MetricTile title="Avg Severity Score" value={avgSev} icon={<TrendingUp className="w-4 h-4 text-blue-400" />} />
      </div>

      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-bold">
            <Trophy className="w-5 h-5 text-yellow-400" /> Repository Leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          {repoScores.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <ShieldCheck className="mb-4 h-12 w-12 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-semibold">No Repositories</h3>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">Connect a repository and run a scan to see security posture analytics.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {repoScores.map((repo, i) => (
                <LeaderboardRow key={repo.repoId} rank={i + 1} repo={repo} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
