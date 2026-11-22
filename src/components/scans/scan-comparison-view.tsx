"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  GitCommit,
  ArrowRight,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  HelpCircle,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SeverityBadge } from "@/components/ui/severity-badge";
import {
  type ScanComparisonResult,
  type ScanFindingItem,
  type SeverityCounts,
} from "@/lib/scans/comparison";

export interface ScanOption {
  id: string;
  headSha?: string | null;
  createdAt: Date | string;
  riskScore?: number;
  policyDecision?: string;
  findingsCount?: number;
  isPartial?: boolean;
}

interface ScanComparisonViewProps {
  pullRequestId: string;
  initialComparison?: ScanComparisonResult | null;
  scans: ScanOption[];
  pullRequestInfo?: {
    id: string;
    prNumber: number;
    title: string;
    repositoryFullName: string;
  };
}

function formatSha(sha?: string | null): string {
  if (!sha) return "unknown";
  return sha.slice(0, 7);
}

function formatScanLabel(scan: ScanOption, index: number, total: number): string {
  const sha = formatSha(scan.headSha);
  const date = new Date(scan.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const tag = index === 0 ? " (Latest)" : index === 1 ? " (Previous)" : "";
  const findingsLabel =
    typeof scan.findingsCount === "number" ? ` • ${scan.findingsCount} findings` : "";
  return `#${total - index}: ${sha} (${date})${findingsLabel}${tag}`;
}

export function ScanComparisonView({
  pullRequestId,
  initialComparison = null,
  scans,
  pullRequestInfo,
}: ScanComparisonViewProps) {
  const defaultTargetId = scans[0]?.id || "";
  const defaultBaseId = scans[1]?.id || scans[0]?.id || "";

  const [baseScanId, setBaseScanId] = useState<string>(
    initialComparison?.baseScan?.id || defaultBaseId,
  );
  const [targetScanId, setTargetScanId] = useState<string>(
    initialComparison?.targetScan?.id || defaultTargetId,
  );
  const [comparison, setComparison] = useState<ScanComparisonResult | null>(initialComparison);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchComparison = async (baseId: string, targetId: string) => {
    if (!baseId || !targetId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/scans/compare?pullRequestId=${encodeURIComponent(
          pullRequestId,
        )}&baseScanId=${encodeURIComponent(baseId)}&targetScanId=${encodeURIComponent(targetId)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: ScanComparisonResult = await res.json();
      setComparison(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load scan comparison");
    } finally {
      setLoading(false);
    }
  };

  const handleBaseChange = (newBaseId: string) => {
    setBaseScanId(newBaseId);
    fetchComparison(newBaseId, targetScanId);
  };

  const handleTargetChange = (newTargetId: string) => {
    setTargetScanId(newTargetId);
    fetchComparison(baseScanId, newTargetId);
  };

  const handleSwap = () => {
    const nextBase = targetScanId;
    const nextTarget = baseScanId;
    setBaseScanId(nextBase);
    setTargetScanId(nextTarget);
    fetchComparison(nextBase, nextTarget);
  };

  return (
    <div className="space-y-6" data-testid="scan-comparison-view">
      {/* Selector Controls Card */}
      <Card className="border-border/60 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <GitCommit className="w-5 h-5 text-primary" />
                Compare Scans
              </CardTitle>
              <CardDescription>
                Diff finding fingerprints between two pushes of this pull request to see what was
                introduced, fixed, or left unchanged.
              </CardDescription>
            </div>
            {scans.length >= 2 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSwap}
                disabled={loading}
                className="gap-1.5 self-start sm:self-auto text-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                Swap Scans
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Base Scan Selector */}
            <div className="space-y-1.5">
              <label
                htmlFor="base-scan-select"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"
              >
                Base Scan (Earlier)
              </label>
              <select
                id="base-scan-select"
                aria-label="Base Scan (Earlier)"
                value={baseScanId}
                onChange={(e) => handleBaseChange(e.target.value)}
                disabled={loading || scans.length === 0}
                className="w-full bg-background/80 border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {scans.map((s, idx) => (
                  <option key={`base-${s.id}`} value={s.id}>
                    {formatScanLabel(s, idx, scans.length)}
                  </option>
                ))}
              </select>
            </div>

            {/* Target Scan Selector */}
            <div className="space-y-1.5">
              <label
                htmlFor="target-scan-select"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"
              >
                Target Scan (Later)
              </label>
              <select
                id="target-scan-select"
                aria-label="Target Scan (Later)"
                value={targetScanId}
                onChange={(e) => handleTargetChange(e.target.value)}
                disabled={loading || scans.length === 0}
                className="w-full bg-background/80 border border-input rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {scans.map((s, idx) => (
                  <option key={`target-${s.id}`} value={s.id}>
                    {formatScanLabel(s, idx, scans.length)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center p-8 text-sm text-muted-foreground gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-primary" />
          Comparing scan fingerprints...
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <Card className="border-red-500/30 bg-red-500/10 text-red-400">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Failed to compare scans</p>
              <p className="text-xs text-red-300 mt-1">{error}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Incomparable warning banner */}
      {comparison && !comparison.isComparable && !loading && (
        <Card
          className="border-amber-500/30 bg-amber-500/10 text-amber-200"
          data-testid="not-comparable-card"
        >
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-semibold text-base text-amber-300">Scans Not Comparable</h4>
              <p className="text-sm text-amber-200/90 mt-1">
                {comparison.incomparableReason ||
                  "These scans cannot be compared because one or both failed or are partial."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {comparison.baseScan && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                    Base: {formatSha(comparison.baseScan.headSha)}
                    {comparison.baseScan.isPartial
                      ? " (Partial)"
                      : comparison.baseScan.isFailed
                        ? " (Failed)"
                        : ""}
                  </Badge>
                )}
                {comparison.targetScan && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                    Target: {formatSha(comparison.targetScan.headSha)}
                    {comparison.targetScan.isPartial
                      ? " (Partial)"
                      : comparison.targetScan.isFailed
                        ? " (Failed)"
                        : ""}
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Comparable Diff Results */}
      {comparison && comparison.isComparable && !loading && (
        <div className="space-y-6" data-testid="comparison-results">
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* New Findings Card */}
            <Card className="border-red-500/20 bg-red-500/[0.05] relative overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-red-400">
                    New Findings
                  </span>
                  <Badge variant="outline" className="border-red-500/30 text-red-400 text-[10px]">
                    Introduced
                  </Badge>
                </div>
                <CardTitle className="text-3xl font-bold text-red-400">
                  {comparison.summary.newCount}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground pt-0">
                <SeverityPills counts={comparison.summary.newSeverityCounts} />
              </CardContent>
            </Card>

            {/* Fixed Findings Card */}
            <Card className="border-emerald-500/20 bg-emerald-500/[0.05] relative overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
                    Fixed Findings
                  </span>
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 text-emerald-400 text-[10px]"
                  >
                    Resolved
                  </Badge>
                </div>
                <CardTitle className="text-3xl font-bold text-emerald-400">
                  {comparison.summary.fixedCount}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground pt-0">
                <SeverityPills counts={comparison.summary.fixedSeverityCounts} />
              </CardContent>
            </Card>

            {/* Unchanged Findings Card */}
            <Card className="border-border/40 bg-card/40 relative overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Unchanged Findings
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    Remaining
                  </Badge>
                </div>
                <CardTitle className="text-3xl font-bold">
                  {comparison.summary.unchangedCount}
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground pt-0">
                <SeverityPills counts={comparison.summary.unchangedSeverityCounts} />
              </CardContent>
            </Card>
          </div>

          {/* Group Tabs & Finding Lists */}
          <Tabs defaultValue="new" className="space-y-4">
            <TabsList className="grid w-full grid-cols-3 max-w-md">
              <TabsTrigger value="new" className="gap-1.5 text-xs">
                New
                <span className="px-1.5 py-0.2 rounded-full bg-red-500/20 text-red-400 text-[10px] font-bold">
                  {comparison.summary.newCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="fixed" className="gap-1.5 text-xs">
                Fixed
                <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                  {comparison.summary.fixedCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="unchanged" className="gap-1.5 text-xs">
                Unchanged
                <span className="px-1.5 py-0.2 rounded-full bg-muted text-muted-foreground text-[10px] font-bold">
                  {comparison.summary.unchangedCount}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="new">
              <FindingsDiffList
                findings={comparison.groups.new.findings}
                emptyMessage="No new findings introduced in this push! 🎉"
                groupStatus="NEW"
              />
            </TabsContent>

            <TabsContent value="fixed">
              <FindingsDiffList
                findings={comparison.groups.fixed.findings}
                emptyMessage="No findings were fixed in this push."
                groupStatus="FIXED"
              />
            </TabsContent>

            <TabsContent value="unchanged">
              <FindingsDiffList
                findings={comparison.groups.unchanged.findings}
                emptyMessage="No unchanged findings."
                groupStatus="UNCHANGED"
              />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function SeverityPills({ counts }: { counts: SeverityCounts }) {
  const parts = [
    counts.CRITICAL > 0 ? { label: "Crit", count: counts.CRITICAL, color: "text-red-400" } : null,
    counts.HIGH > 0 ? { label: "High", count: counts.HIGH, color: "text-orange-400" } : null,
    counts.MEDIUM > 0 ? { label: "Med", count: counts.MEDIUM, color: "text-yellow-400" } : null,
    counts.LOW > 0 ? { label: "Low", count: counts.LOW, color: "text-blue-400" } : null,
  ].filter(Boolean) as Array<{ label: string; count: number; color: string }>;

  if (parts.length === 0) {
    return <span className="text-muted-foreground">0 issues</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {parts.map((p) => (
        <span key={p.label} className={`font-mono font-medium ${p.color}`}>
          {p.count} {p.label}
        </span>
      ))}
    </div>
  );
}

function FindingsDiffList({
  findings,
  emptyMessage,
  groupStatus,
}: {
  findings: ScanFindingItem[];
  emptyMessage: string;
  groupStatus: "NEW" | "FIXED" | "UNCHANGED";
}) {
  if (findings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/80 p-8 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {findings.map((f) => (
        <div
          key={f.id}
          className="rounded-lg border border-border/60 bg-card/60 p-4 transition-all hover:border-primary/40 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={f.severity} />
              <Badge variant="outline" className="text-xs">
                {f.type}
              </Badge>
              <span className="font-mono text-xs font-semibold text-foreground/90">
                {f.fileLocation}
                {f.lineStart ? `:${f.lineStart}` : ""}
              </span>
            </div>

            <Link
              href={`/dashboard/findings/${f.id}`}
              className="inline-flex items-center text-xs font-medium text-primary hover:underline gap-1 ml-auto"
            >
              View Finding
              <ExternalLink className="w-3 h-3" />
            </Link>
          </div>

          {f.codeSnippet && (
            <pre className="rounded bg-black/40 border border-white/5 p-2 text-xs font-mono overflow-x-auto text-muted-foreground max-h-32">
              <code>{f.codeSnippet}</code>
            </pre>
          )}

          {f.explanation && (
            <p className="text-xs text-muted-foreground line-clamp-2">{f.explanation}</p>
          )}
        </div>
      ))}
    </div>
  );
}
