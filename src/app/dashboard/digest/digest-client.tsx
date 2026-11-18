"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TimeAgo } from "@/components/time-ago";
import { requestManualDigestGeneration } from "@/lib/actions/digest";
import {
  Mail,
  RefreshCw,
  FolderGit2,
  Bug,
  Calendar,
  AlertCircle,
} from "lucide-react";

export interface SerializedDigestRepoMetric {
  repositoryId: string;
  fullName: string;
  name: string;
  openFindingsCount: number;
  criticalCount: number;
}

export interface SerializedDigestFindingTypeMetric {
  type: string;
  count: number;
  severity: string;
}

export interface SerializedDigest {
  id: string;
  startDate: string;
  endDate: string;
  newFindingsCount: number;
  dismissedFindingsCount: number;
  resolvedFindingsCount: number;
  blockedPrsCount: number;
  topRepositories: SerializedDigestRepoMetric[];
  topFindingTypes: SerializedDigestFindingTypeMetric[];
  sentAt: string | null;
  createdAt: string;
}

interface DigestClientProps {
  initialDigests: SerializedDigest[];
  weeklyDigestEnabled: boolean;
  userEmail: string | null;
  userName: string | null;
}

function formatDateRange(startIso: string, endIso: string): string {
  try {
    const s = new Date(startIso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    const e = new Date(endIso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    return `${s} – ${e} (UTC)`;
  } catch {
    return `${startIso.slice(0, 10)} – ${endIso.slice(0, 10)}`;
  }
}

export default function DigestClient({
  initialDigests,
  weeklyDigestEnabled,
  userEmail,
  userName,
}: DigestClientProps) {
  const [digests, setDigests] = useState<SerializedDigest[]>(initialDigests);
  const [selectedDigestId, setSelectedDigestId] = useState<string | null>(
    initialDigests[0]?.id ?? null,
  );
  const [isGenerating, startGeneration] = useTransition();

  const activeDigest = digests.find((d) => d.id === selectedDigestId) || digests[0] || null;

  const handleGenerateNow = () => {
    startGeneration(async () => {
      try {
        const result = await requestManualDigestGeneration();
        if (result.success && result.digest) {
          const newDigest: SerializedDigest = {
            id: result.digest.id,
            startDate: new Date(result.digest.startDate).toISOString(),
            endDate: new Date(result.digest.endDate).toISOString(),
            newFindingsCount: result.digest.newFindingsCount,
            dismissedFindingsCount: result.digest.dismissedFindingsCount,
            resolvedFindingsCount: result.digest.resolvedFindingsCount,
            blockedPrsCount: result.digest.blockedPrsCount,
            topRepositories: (result.digest.topRepositories as any) || [],
            topFindingTypes: (result.digest.topFindingTypes as any) || [],
            sentAt: result.digest.sentAt ? new Date(result.digest.sentAt).toISOString() : null,
            createdAt: new Date(result.digest.createdAt).toISOString(),
          };

          setDigests((prev) => [newDigest, ...prev.filter((d) => d.id !== newDigest.id)]);
          setSelectedDigestId(newDigest.id);
          toast.success(result.message || "Weekly digest generated successfully!");
        } else {
          toast.error(result.message || "Could not generate digest.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to trigger digest generation.");
      }
    });
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-6xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-widest text-primary">
            Executive Intelligence
          </span>
          <h1 className="mt-1 font-headline text-3xl font-extrabold tracking-tight">
            Security Digest
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Weekly aggregated security posture, findings velocity, and repository risk briefings.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            onClick={handleGenerateNow}
            disabled={isGenerating}
            variant="default"
            className="gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${isGenerating ? "animate-spin" : ""}`} />
            {isGenerating ? "Generating..." : "Generate Digest Now"}
          </Button>
        </div>
      </div>

      {/* Opt-out notice if disabled in settings */}
      {!weeklyDigestEnabled && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertCircle className="w-5 h-5 shrink-0 text-amber-400" />
          <div className="flex-1">
            <span className="font-semibold">Weekly email digest is turned off.</span> You can still
            view past summaries here or re-enable automated delivery in{" "}
            <Link href="/dashboard/settings" className="underline hover:text-white font-medium">
              Settings
            </Link>
            .
          </div>
        </div>
      )}

      {/* Empty State */}
      {digests.length === 0 ? (
        <Card className="glass-card text-center py-12">
          <CardContent className="space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <Mail className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold">No Security Digests Yet</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Digests are automatically built every week summarizing new vulnerabilities, triage
                actions, and blocked pull requests.
              </p>
            </div>
            <Button
              onClick={handleGenerateNow}
              disabled={isGenerating}
              variant="outline"
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${isGenerating ? "animate-spin" : ""}`} />
              {isGenerating ? "Generating..." : "Generate Your First Digest"}
            </Button>
          </CardContent>
        </Card>
      ) : activeDigest ? (
        <>
          {/* Active Digest Overview Card */}
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border/50 pb-3">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">
                  Reporting Period: {formatDateRange(activeDigest.startDate, activeDigest.endDate)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <span>Generated:</span>
                <TimeAgo date={activeDigest.createdAt} />
                {activeDigest.sentAt && (
                  <span className="ml-2 inline-flex items-center gap-1 text-emerald-400">
                    <Mail className="w-3 h-3" /> Sent via email
                  </span>
                )}
              </div>
            </div>

            {/* Metric Tiles */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Card className="glass-card border-l-4 border-l-blue-500">
                <CardHeader className="pb-2">
                  <CardDescription className="text-xs uppercase tracking-wider font-semibold">
                    New Findings
                  </CardDescription>
                  <CardTitle className="text-3xl font-extrabold text-blue-400">
                    {activeDigest.newFindingsCount}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Detected during this 7-day window
                </CardContent>
              </Card>

              <Card className="glass-card border-l-4 border-l-emerald-500">
                <CardHeader className="pb-2">
                  <CardDescription className="text-xs uppercase tracking-wider font-semibold">
                    Resolved Findings
                  </CardDescription>
                  <CardTitle className="text-3xl font-extrabold text-emerald-400">
                    {activeDigest.resolvedFindingsCount}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Triaged or patched in code
                </CardContent>
              </Card>

              <Card className="glass-card border-l-4 border-l-zinc-500">
                <CardHeader className="pb-2">
                  <CardDescription className="text-xs uppercase tracking-wider font-semibold">
                    Dismissed Findings
                  </CardDescription>
                  <CardTitle className="text-3xl font-extrabold text-zinc-300">
                    {activeDigest.dismissedFindingsCount}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  False positives or accepted risk
                </CardContent>
              </Card>

              <Card className="glass-card border-l-4 border-l-red-500">
                <CardHeader className="pb-2">
                  <CardDescription className="text-xs uppercase tracking-wider font-semibold">
                    Blocked PRs
                  </CardDescription>
                  <CardTitle className="text-3xl font-extrabold text-red-400">
                    {activeDigest.blockedPrsCount}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-muted-foreground">
                  Pull requests gated by security rules
                </CardContent>
              </Card>
            </div>

            {/* Top Repositories & Top Recurring Finding Types */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Top 5 Repositories */}
              <Card className="glass-card">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="w-5 h-5 text-primary" />
                    <div>
                      <CardTitle className="text-lg">Top Repositories by Open Findings</CardTitle>
                      <CardDescription className="text-xs">
                        Repositories requiring the most security attention
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {activeDigest.topRepositories.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No open findings across any repositories. All clear!
                    </p>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {activeDigest.topRepositories.map((repo, idx) => (
                        <div
                          key={repo.repositoryId || idx}
                          className="flex items-center justify-between py-2.5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <span className="text-xs font-mono text-muted-foreground w-4">
                              #{idx + 1}
                            </span>
                            <span className="font-medium truncate font-mono text-xs">
                              {repo.fullName}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {repo.criticalCount > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                                {repo.criticalCount} CRITICAL
                              </span>
                            )}
                            <span className="text-xs font-bold text-muted-foreground">
                              {repo.openFindingsCount} open
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Top 5 Recurring Finding Types */}
              <Card className="glass-card">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Bug className="w-5 h-5 text-amber-400" />
                    <div>
                      <CardTitle className="text-lg">Top Recurring Finding Types</CardTitle>
                      <CardDescription className="text-xs">
                        Most common vulnerability patterns identified
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {activeDigest.topFindingTypes.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      No open vulnerability patterns found this period.
                    </p>
                  ) : (
                    <div className="divide-y divide-border/40">
                      {activeDigest.topFindingTypes.map((item, idx) => (
                        <div
                          key={item.type || idx}
                          className="flex items-center justify-between py-2.5 text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <span className="text-xs font-mono text-muted-foreground w-4">
                              #{idx + 1}
                            </span>
                            <span className="font-mono text-xs truncate">{item.type}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold ${
                                item.severity === "CRITICAL"
                                  ? "bg-red-500/20 text-red-400 border border-red-500/30"
                                  : item.severity === "HIGH"
                                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                    : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                              }`}
                            >
                              {item.severity}
                            </span>
                            <span className="text-xs font-bold">{item.count}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Historical Digests Table */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="text-lg">Digest Archive</CardTitle>
              <CardDescription className="text-xs">
                History of weekly security snapshots generated for your account.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border/60 text-xs uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="py-3 px-4">Period</th>
                      <th className="py-3 px-4">New</th>
                      <th className="py-3 px-4">Resolved</th>
                      <th className="py-3 px-4">Dismissed</th>
                      <th className="py-3 px-4">Blocked PRs</th>
                      <th className="py-3 px-4">Generated</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {digests.map((digest) => {
                      const isCurrent = digest.id === activeDigest.id;
                      return (
                        <tr
                          key={digest.id}
                          className={`hover:bg-white/5 transition-colors ${
                            isCurrent ? "bg-primary/5 font-medium" : ""
                          }`}
                        >
                          <td className="py-3 px-4 font-mono text-xs">
                            {formatDateRange(digest.startDate, digest.endDate)}
                          </td>
                          <td className="py-3 px-4 text-blue-400 font-semibold">
                            {digest.newFindingsCount}
                          </td>
                          <td className="py-3 px-4 text-emerald-400 font-semibold">
                            {digest.resolvedFindingsCount}
                          </td>
                          <td className="py-3 px-4 text-muted-foreground">
                            {digest.dismissedFindingsCount}
                          </td>
                          <td className="py-3 px-4 text-red-400 font-semibold">
                            {digest.blockedPrsCount}
                          </td>
                          <td className="py-3 px-4 text-xs text-muted-foreground">
                            <TimeAgo date={digest.createdAt} />
                          </td>
                          <td className="py-3 px-4 text-right">
                            <Button
                              size="sm"
                              variant={isCurrent ? "secondary" : "ghost"}
                              onClick={() => setSelectedDigestId(digest.id)}
                              className="text-xs h-7 px-2.5"
                            >
                              {isCurrent ? "Viewing" : "View"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
