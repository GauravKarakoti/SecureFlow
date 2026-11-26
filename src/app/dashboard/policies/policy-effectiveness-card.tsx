"use client";

import { useState, useEffect, useCallback } from "react";
import {
  BarChart3,
  Download,
  AlertTriangle,
  Clock,
  CheckCircle2,
  Filter,
  Loader2,
  Info,
  ShieldAlert,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SeverityBadge } from "@/components/ui/severity-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PolicyEffectivenessSummary, PolicyMetricRow } from "@/lib/policies/effectiveness";

interface PolicyEffectivenessCardProps {
  initialData?: PolicyEffectivenessSummary | null;
}

export function PolicyEffectivenessCard({ initialData }: PolicyEffectivenessCardProps) {
  const [period, setPeriod] = useState<number>(30);
  const [summary, setSummary] = useState<PolicyEffectivenessSummary | null>(initialData || null);
  const [loading, setLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "noisy" | "inactive" | "healthy">("ALL");

  const loadData = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/policies/effectiveness?days=${days}`);
      if (!res.ok) {
        throw new Error(`Failed to load effectiveness data (${res.status})`);
      }
      const data: PolicyEffectivenessSummary = await res.json();
      setSummary(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load report");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Only fetch if initialData is not provided or period has changed
    if (!initialData || period !== initialData.periodDays) {
      loadData(period);
    }
  }, [period, initialData, loadData]);

  const policies: PolicyMetricRow[] = summary?.policies || [];

  const filteredPolicies = policies.filter((p) => {
    const matchesSearch =
      searchQuery.trim() === "" ||
      p.policyName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "ALL" || p.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <Card className="glass-card border-white/10 bg-black/40">
      <CardHeader className="pb-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              <CardTitle className="text-xl font-bold">Policy Effectiveness Report</CardTitle>
            </div>
            <CardDescription className="mt-1">
              Analyze hit rates, false positive ratios, and resolution times to detect noisy or
              inactive policies.
            </CardDescription>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Period Selector Buttons */}
            <div
              className="inline-flex rounded-lg bg-white/5 p-1 border border-white/10"
              role="group"
              aria-label="Evaluation Period"
            >
              {[7, 30, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setPeriod(d)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                    period === d
                      ? "bg-primary text-primary-foreground shadow"
                      : "text-muted-foreground hover:text-white"
                  }`}
                  data-testid={`period-btn-${d}`}
                >
                  {d}d
                </button>
              ))}
            </div>

            {/* Export CSV Button */}
            <Button
              variant="outline"
              size="sm"
              asChild
              className="border-white/10 hover:bg-white/10 gap-1.5"
            >
              <a
                href={`/api/policies/effectiveness/export?days=${period}`}
                download={`policy-effectiveness-report-${period}d.csv`}
                data-testid="export-csv-btn"
              >
                <Download className="w-4 h-4" />
                Export CSV
              </a>
            </Button>
          </div>
        </div>

        {/* Top Summary Metrics */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 pt-4 border-t border-white/10">
            <div className="p-3 rounded-lg bg-white/[0.03] border border-white/5">
              <p className="text-xs text-muted-foreground">Total Policies</p>
              <p className="text-2xl font-bold mt-1" data-testid="metric-total-policies">
                {summary.totalPolicies}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-white/[0.03] border border-white/5">
              <p className="text-xs text-muted-foreground">Findings Evaluated</p>
              <p className="text-2xl font-bold mt-1" data-testid="metric-total-findings">
                {summary.totalFindingsEvaluated}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-rose-400">Noisy Policies</p>
                <AlertTriangle className="w-4 h-4 text-rose-400" />
              </div>
              <p
                className="text-2xl font-bold text-rose-300 mt-1"
                data-testid="metric-noisy-policies"
              >
                {summary.noisyPolicies}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-zinc-500/10 border border-zinc-500/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-400">Inactive Policies</p>
                <Clock className="w-4 h-4 text-zinc-400" />
              </div>
              <p
                className="text-2xl font-bold text-zinc-300 mt-1"
                data-testid="metric-inactive-policies"
              >
                {summary.inactivePolicies}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-emerald-400">Healthy Policies</p>
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              </div>
              <p
                className="text-2xl font-bold text-emerald-300 mt-1"
                data-testid="metric-healthy-policies"
              >
                {summary.healthyPolicies}
              </p>
            </div>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Search & Filter Toolbar */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Input
              type="text"
              placeholder="Filter policies by name or keyword..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-black/30 border-white/10 text-sm"
              data-testid="policy-search-input"
            />
          </div>

          <div className="flex items-center gap-1.5 self-end sm:self-auto">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-xs text-muted-foreground mr-1">Status:</span>
            {(["ALL", "noisy", "inactive", "healthy"] as const).map((status) => (
              <Button
                key={status}
                variant={statusFilter === status ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setStatusFilter(status)}
                className="h-7 text-xs px-2.5"
                data-testid={`filter-status-${status}`}
              >
                {status === "ALL" ? "All" : status.charAt(0).toUpperCase() + status.slice(1)}
              </Button>
            ))}
          </div>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mb-2" />
            <p className="text-sm">Calculating policy effectiveness metrics...</p>
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Table content */}
        {!loading && !error && (
          <div className="rounded-lg border border-white/10 overflow-hidden">
            <Table>
              <TableHeader className="bg-white/[0.02]">
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableHead className="w-[30%]">Policy</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[12%] text-right">Findings (Hits)</TableHead>
                  <TableHead className="w-[15%] text-right">False Positive Share</TableHead>
                  <TableHead className="w-[15%] text-right">Resolved Share</TableHead>
                  <TableHead className="w-[16%] text-right">Avg Resolution Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPolicies.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No policies match the selected criteria.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredPolicies.map((p) => (
                    <TableRow
                      key={p.policyId}
                      className="border-white/5 hover:bg-white/[0.02]"
                      data-testid={`policy-row-${p.policyId}`}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <SeverityBadge
                            severity={p.severity}
                            className="text-[10px] px-1.5 py-0"
                          />
                          <span className="font-medium text-sm text-foreground">
                            {p.policyName}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                          {p.description}
                        </p>
                      </TableCell>

                      <TableCell>
                        {p.status === "noisy" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-rose-500/15 text-rose-400 border border-rose-500/30"
                            role="status"
                            data-testid={`badge-status-${p.policyId}`}
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Noisy
                          </span>
                        )}
                        {p.status === "inactive" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-zinc-500/15 text-zinc-400 border border-zinc-500/30"
                            role="status"
                            data-testid={`badge-status-${p.policyId}`}
                          >
                            <Clock className="w-3 h-3" />
                            Inactive
                          </span>
                        )}
                        {p.status === "healthy" && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            role="status"
                            data-testid={`badge-status-${p.policyId}`}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            Healthy
                          </span>
                        )}
                      </TableCell>

                      <TableCell className="text-right font-medium">{p.totalFindings}</TableCell>

                      <TableCell className="text-right">
                        {p.totalFindings === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div>
                            <span
                              className={`font-semibold text-xs ${
                                p.falsePositiveRate >= 50
                                  ? "text-rose-400"
                                  : p.falsePositiveRate > 20
                                    ? "text-amber-400"
                                    : "text-muted-foreground"
                              }`}
                            >
                              {p.falsePositiveRate.toFixed(1)}%
                            </span>
                            <span className="text-xs text-muted-foreground ml-1">
                              ({p.falsePositiveCount})
                            </span>
                          </div>
                        )}
                      </TableCell>

                      <TableCell className="text-right">
                        {p.totalFindings === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div>
                            <span className="text-xs font-medium text-foreground">
                              {p.resolvedRate.toFixed(1)}%
                            </span>
                            <span className="text-xs text-muted-foreground ml-1">
                              ({p.resolvedCount})
                            </span>
                          </div>
                        )}
                      </TableCell>

                      <TableCell className="text-right text-xs text-muted-foreground">
                        {p.avgResolutionTimeFormatted}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Documentation / Legend footnote */}
        <div className="flex items-start gap-2 pt-2 text-xs text-muted-foreground border-t border-white/5">
          <Info className="w-4 h-4 flex-shrink-0 text-muted-foreground mt-0.5" />
          <p>
            <strong className="text-foreground">Thresholds:</strong> Policies are classified as{" "}
            <span className="text-rose-400 font-medium">Noisy</span> if their false-positive rate is
            &ge;50% with at least 3 findings. Policies with 0 recorded findings in the period are
            labeled <span className="text-zinc-400 font-medium">Inactive</span>. Formula injection
            mitigation applies to all exported CSV rows.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
