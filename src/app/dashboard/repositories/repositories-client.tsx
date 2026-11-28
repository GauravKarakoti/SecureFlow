"use client";

import React, { useState, useMemo } from "react";
import Link from "next/link";
import {
  FolderGit2,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Clock,
  Ban,
  Search,
  ArrowUpDown,
  Filter,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Plus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TrendSparkline } from "@/components/repositories/trend-sparkline";
import { ConnectRepositoryWizard } from "@/components/repositories/connect-repository-wizard";
import { HEALTH_SCORE_FORMULA_DOCS } from "@/lib/repositories/health-score";
import type { RepositoryHealthItem, RepositoriesOverviewData } from "@/lib/repositories/types";

interface RepositoriesClientProps {
  initialData: RepositoriesOverviewData;
}

type SortField =
  "score-desc" | "score-asc" | "name-asc" | "name-desc" | "findings-desc" | "blocked-desc";

type TierFilter = "ALL" | "EXCELLENT" | "GOOD" | "NEEDS_ATTENTION" | "AT_RISK" | "UNRANKED";

export default function RepositoriesClient({ initialData }: RepositoriesClientProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("ALL");
  const [sortField, setSortField] = useState<SortField>("score-desc");
  const [showFormulaDocs, setShowFormulaDocs] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [connectWizardOpen, setConnectWizardOpen] = useState(false);

  // Auto-open wizard if ?connect=true query param is present
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("connect") === "true" || params.get("connect") === "1") {
        setConnectWizardOpen(true);
      }
    }
  }, []);

  // Filter repositories
  const filteredRepos = useMemo(() => {
    return initialData.repositories.filter((repo) => {
      // Search term
      if (
        searchTerm.trim() &&
        !repo.fullName.toLowerCase().includes(searchTerm.trim().toLowerCase()) &&
        !repo.owner.toLowerCase().includes(searchTerm.trim().toLowerCase())
      ) {
        return false;
      }

      // Tier filter
      if (tierFilter !== "ALL") {
        if (repo.healthTier !== tierFilter) {
          return false;
        }
      }

      return true;
    });
  }, [initialData.repositories, searchTerm, tierFilter]);

  // Sort repositories
  const sortedRepos = useMemo(() => {
    const list = [...filteredRepos];
    list.sort((a, b) => {
      switch (sortField) {
        case "score-desc": {
          // Put null scores at the end
          if (a.healthScore === null && b.healthScore === null)
            return a.fullName.localeCompare(b.fullName);
          if (a.healthScore === null) return 1;
          if (b.healthScore === null) return -1;
          return b.healthScore - a.healthScore;
        }
        case "score-asc": {
          if (a.healthScore === null && b.healthScore === null)
            return a.fullName.localeCompare(b.fullName);
          if (a.healthScore === null) return 1;
          if (b.healthScore === null) return -1;
          return a.healthScore - b.healthScore;
        }
        case "name-asc":
          return a.fullName.localeCompare(b.fullName);
        case "name-desc":
          return b.fullName.localeCompare(a.fullName);
        case "findings-desc":
          return b.openFindings.total - a.openFindings.total;
        case "blocked-desc":
          return b.blockedPrsLast30Days - a.blockedPrsLast30Days;
        default:
          return 0;
      }
    });
    return list;
  }, [filteredRepos, sortField]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedRepos.length / pageSize));
  const paginatedRepos = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedRepos.slice(start, start + pageSize);
  }, [sortedRepos, currentPage, pageSize]);

  // Reset page when filters change
  const handleSearchChange = (val: string) => {
    setSearchTerm(val);
    setCurrentPage(1);
  };

  const handleTierChange = (val: TierFilter) => {
    setTierFilter(val);
    setCurrentPage(1);
  };

  const handleSortChange = (val: SortField) => {
    setSortField(val);
    setCurrentPage(1);
  };

  const getTierBadge = (repo: RepositoryHealthItem) => {
    if (!repo.hasScans || repo.healthScore === null) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-mono font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
          Unranked (No Scans)
        </span>
      );
    }

    if (repo.healthScore >= 90) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {repo.healthScore} / 100 · Excellent
        </span>
      );
    }
    if (repo.healthScore >= 75) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          {repo.healthScore} / 100 · Good
        </span>
      );
    }
    if (repo.healthScore >= 50) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          {repo.healthScore} / 100 · Needs Attention
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
        {repo.healthScore} / 100 · At Risk
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* ─── Header & Top Actions ────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold font-headline tracking-wider uppercase text-foreground flex items-center gap-2.5">
            <FolderGit2 className="w-6 h-6 text-primary" />
            Repository Security Overview
          </h1>
          <p className="text-sm text-muted-foreground mt-1 font-mono">
            Comparative security benchmarks, open finding distributions, and 8-week health trends.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button
            variant="default"
            size="sm"
            onClick={() => setConnectWizardOpen(true)}
            className="text-xs font-mono gap-1.5"
            data-testid="connect-repo-btn"
          >
            <Plus className="w-3.5 h-3.5" />
            Connect Repository
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFormulaDocs(!showFormulaDocs)}
            className="border-zinc-700 bg-zinc-900/50 hover:bg-zinc-800 text-xs font-mono gap-1.5"
          >
            <Info className="w-3.5 h-3.5 text-primary" />
            {showFormulaDocs ? "Hide Formula" : "Scoring Formula"}
            {showFormulaDocs ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* ─── Formula Documentation Collapsible ──────────────────────────── */}
      {showFormulaDocs && (
        <Card className="border-primary/30 bg-primary/5 shadow-lg animate-in fade-in-50 duration-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-primary font-mono flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              {HEALTH_SCORE_FORMULA_DOCS.title}
            </CardTitle>
            <CardDescription className="text-xs text-muted-foreground font-mono">
              {HEALTH_SCORE_FORMULA_DOCS.summary}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 text-xs font-mono">
              {HEALTH_SCORE_FORMULA_DOCS.rules.map((rule, idx) => (
                <div
                  key={idx}
                  className="p-2.5 rounded border border-white/5 bg-zinc-950/60 flex flex-col justify-between"
                >
                  <span className="font-semibold text-zinc-300">{rule.metric}</span>
                  <span className="text-zinc-400 text-[11px] mt-0.5">{rule.formula}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-white/5 flex flex-wrap gap-4 text-[11px] font-mono text-muted-foreground">
              <span>
                <strong className="text-emerald-400">90–100:</strong> Excellent
              </span>
              <span>
                <strong className="text-cyan-400">75–89:</strong> Good
              </span>
              <span>
                <strong className="text-amber-400">50–74:</strong> Needs Attention
              </span>
              <span>
                <strong className="text-rose-400">&lt; 50:</strong> At Risk
              </span>
              <span>
                <strong className="text-zinc-400">Unranked:</strong> No scans recorded
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Metric Summary Cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card/60 border-white/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Connected Repos
              <FolderGit2 className="w-4 h-4 text-zinc-400" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground">
              {initialData.totalConnected}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60 border-white/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Avg Health Score
              <ShieldCheck className="w-4 h-4 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground flex items-baseline gap-2">
              {initialData.averageHealthScore !== null ? (
                <>
                  <span>{initialData.averageHealthScore}</span>
                  <span className="text-xs text-muted-foreground font-normal">/ 100</span>
                </>
              ) : (
                <span className="text-zinc-500 font-normal text-lg">—</span>
              )}
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60 border-white/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Open Critical & High
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-rose-400 flex items-baseline gap-2">
              {initialData.totalOpenCritical + initialData.totalOpenHigh}
              <span className="text-xs text-muted-foreground font-normal">
                ({initialData.totalOpenCritical} crit, {initialData.totalOpenHigh} high)
              </span>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card className="bg-card/60 border-white/5">
          <CardHeader className="pb-2">
            <CardDescription className="text-xs font-mono uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Blocked PRs (30d)
              <Ban className="w-4 h-4 text-amber-400" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-amber-400">
              {initialData.totalBlockedPrs30Days}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* ─── Search, Filter, & Sort Controls ─────────────────────────────── */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search repositories by name or owner..."
            value={searchTerm}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 bg-zinc-900/60 border-zinc-800 text-sm font-mono min-h-[44px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Score Tier Filter */}
          <div className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800 rounded-md px-3 py-1.5 text-xs font-mono min-h-[44px]">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Tier:</span>
            <select
              value={tierFilter}
              onChange={(e) => handleTierChange(e.target.value as TierFilter)}
              className="bg-transparent text-foreground focus:outline-none cursor-pointer"
            >
              <option value="ALL" className="bg-zinc-900">
                All Tiers
              </option>
              <option value="EXCELLENT" className="bg-zinc-900">
                Excellent (90–100)
              </option>
              <option value="GOOD" className="bg-zinc-900">
                Good (75–89)
              </option>
              <option value="NEEDS_ATTENTION" className="bg-zinc-900">
                Needs Attention (50–74)
              </option>
              <option value="AT_RISK" className="bg-zinc-900">
                At Risk (&lt; 50)
              </option>
              <option value="UNRANKED" className="bg-zinc-900">
                Unranked (No Scans)
              </option>
            </select>
          </div>

          {/* Sort By Dropdown */}
          <div className="flex items-center gap-1.5 bg-zinc-900/60 border border-zinc-800 rounded-md px-3 py-1.5 text-xs font-mono min-h-[44px]">
            <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Sort:</span>
            <select
              value={sortField}
              onChange={(e) => handleSortChange(e.target.value as SortField)}
              className="bg-transparent text-foreground focus:outline-none cursor-pointer"
            >
              <option value="score-desc" className="bg-zinc-900">
                Health Score: High to Low
              </option>
              <option value="score-asc" className="bg-zinc-900">
                Health Score: Low to High
              </option>
              <option value="name-asc" className="bg-zinc-900">
                Name: A to Z
              </option>
              <option value="name-desc" className="bg-zinc-900">
                Name: Z to A
              </option>
              <option value="findings-desc" className="bg-zinc-900">
                Open Findings: Most to Least
              </option>
              <option value="blocked-desc" className="bg-zinc-900">
                Blocked PRs: Most to Least
              </option>
            </select>
          </div>
        </div>
      </div>

      {/* ─── Repositories Table / Grid ───────────────────────────────────── */}
      {initialData.repositories.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-zinc-800 bg-zinc-900/20">
          <FolderGit2 className="w-12 h-12 mx-auto text-zinc-600 mb-3" />
          <h3 className="text-base font-bold font-headline uppercase tracking-wider text-foreground">
            No Connected Repositories
          </h3>
          <p className="text-xs font-mono text-muted-foreground mt-1 max-w-sm mx-auto">
            Install the SecureFlow GitHub App or synchronize your repositories to view security
            health rankings.
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <Button
              size="sm"
              variant="default"
              onClick={() => setConnectWizardOpen(true)}
              className="font-mono text-xs gap-1.5"
              data-testid="empty-connect-repo-btn"
            >
              <Plus className="w-3.5 h-3.5" />
              Connect Repository Wizard
            </Button>
            <Link href="/dashboard/settings">
              <Button size="sm" variant="outline" className="font-mono text-xs border-zinc-700">
                Go to Settings
              </Button>
            </Link>
          </div>
        </Card>
      ) : sortedRepos.length === 0 ? (
        <Card className="p-10 text-center border-dashed border-zinc-800 bg-zinc-900/20">
          <Search className="w-8 h-8 mx-auto text-zinc-600 mb-2" />
          <p className="text-sm font-mono text-muted-foreground">
            No repositories matched your search or filter criteria.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSearchTerm("");
              setTierFilter("ALL");
            }}
            className="mt-3 text-xs font-mono text-primary hover:text-primary/80"
          >
            Clear Filters
          </Button>
        </Card>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-end gap-1.5 text-[11px] font-mono text-muted-foreground sm:hidden px-1 pb-1">
            <span>Scroll table horizontally</span>
            <span aria-hidden="true">&rarr;</span>
          </div>
          <div className="rounded-md border border-white/5 bg-card/60 overflow-hidden shadow">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm min-w-[640px]">
                <thead className="sticky top-0 bg-zinc-950/95 backdrop-blur z-10 border-b border-white/5">
                  <tr className="border-b border-white/5 bg-zinc-950/80 text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    <th className="py-3 px-4 font-semibold">Repository</th>
                    <th className="py-3 px-4 font-semibold">Health Score</th>
                    <th className="py-3 px-4 font-semibold">8-Week Trend</th>
                    <th className="py-3 px-4 font-semibold">Open Findings</th>
                    <th className="py-3 px-4 font-semibold">Blocked PRs (30d)</th>
                    <th className="py-3 px-4 font-semibold">Median Resolve</th>
                    <th className="py-3 px-4 font-semibold text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono text-xs">
                  {paginatedRepos.map((repo) => (
                    <tr key={repo.id} className="hover:bg-white/[0.02] transition-colors group">
                      {/* Repository Name & Link */}
                      <td className="py-3.5 px-4 font-medium">
                        <Link
                          href={`/dashboard/findings?repo=${repo.id}`}
                          className="flex items-center gap-2 text-foreground group-hover:text-primary transition-colors font-semibold"
                          title={`View findings for ${repo.fullName}`}
                        >
                          <FolderGit2 className="w-4 h-4 text-zinc-400 group-hover:text-primary shrink-0" />
                          <span>{repo.fullName}</span>
                        </Link>
                        <span className="text-[10px] text-zinc-500 block pl-6">
                          {repo.hasScans && repo.lastScanAt
                            ? `Last scanned ${new Date(repo.lastScanAt).toLocaleDateString()}`
                            : "No scans recorded"}
                        </span>
                      </td>

                      {/* Health Score */}
                      <td className="py-3.5 px-4 whitespace-nowrap">{getTierBadge(repo)}</td>

                      {/* 8-Week Sparkline Trend */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <TrendSparkline data={repo.trend} width={110} height={28} />
                      </td>

                      {/* Open Findings Breakdown */}
                      <td className="py-3.5 px-4">
                        {repo.hasScans ? (
                          <Link
                            href={`/dashboard/findings?repo=${repo.id}`}
                            className="flex flex-wrap items-center gap-1.5 hover:opacity-80 transition-opacity"
                            title="Click to view open findings"
                          >
                            {repo.openFindings.critical > 0 && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">
                                {repo.openFindings.critical} crit
                              </span>
                            )}
                            {repo.openFindings.high > 0 && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                                {repo.openFindings.high} high
                              </span>
                            )}
                            {repo.openFindings.medium > 0 && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                                {repo.openFindings.medium} med
                              </span>
                            )}
                            {repo.openFindings.low > 0 && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/20 text-blue-400 border border-blue-500/30">
                                {repo.openFindings.low} low
                              </span>
                            )}
                            {repo.openFindings.total === 0 && (
                              <span className="text-[11px] text-emerald-400 flex items-center gap-1 font-semibold">
                                <ShieldCheck className="w-3.5 h-3.5" /> 0 open
                              </span>
                            )}
                          </Link>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>

                      {/* Blocked PRs in last 30d */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {repo.blockedPrsLast30Days > 0 ? (
                          <span className="text-amber-400 font-bold flex items-center gap-1">
                            <Ban className="w-3.5 h-3.5 shrink-0" />
                            {repo.blockedPrsLast30Days}
                          </span>
                        ) : (
                          <span className="text-zinc-500">0</span>
                        )}
                      </td>

                      {/* Median Time to Resolve */}
                      <td className="py-3.5 px-4 whitespace-nowrap text-zinc-300">
                        {repo.medianResolveTimeFormatted !== "—" ? (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                            {repo.medianResolveTimeFormatted}
                          </span>
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>

                      {/* Action Link */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <Link href={`/dashboard/findings?repo=${repo.id}`}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2.5 text-xs font-mono text-primary hover:text-primary hover:bg-primary/10 gap-1"
                          >
                            Findings
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ─── Pagination Footer ────────────────────────────────────────── */}
            <div className="p-3 border-t border-white/5 bg-zinc-950/60 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs font-mono text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>
                  Showing {Math.min((currentPage - 1) * pageSize + 1, sortedRepos.length)}–
                  {Math.min(currentPage * pageSize, sortedRepos.length)} of {sortedRepos.length}{" "}
                  repositories
                </span>

                <div className="flex items-center gap-1 ml-3 border-l border-white/10 pl-3">
                  <span>Per page:</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    className="bg-zinc-900 border border-zinc-800 text-foreground rounded px-1.5 py-0.5 text-xs focus:outline-none cursor-pointer"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="min-h-[44px] min-w-[44px] px-3 border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800 text-xs inline-flex items-center justify-center"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <span className="px-2">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage >= totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  className="min-h-[44px] min-w-[44px] px-3 border-zinc-800 bg-zinc-900/50 hover:bg-zinc-800 text-xs inline-flex items-center justify-center"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Connect Repository Step-by-Step Wizard (#2230) ─────────────── */}
      <ConnectRepositoryWizard
        open={connectWizardOpen}
        onOpenChange={setConnectWizardOpen}
        initialRepositories={initialData.repositories}
      />
    </div>
  );
}
