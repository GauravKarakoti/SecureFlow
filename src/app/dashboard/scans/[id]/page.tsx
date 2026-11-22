import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import prisma from "@/lib/prisma";
import Link from "next/link";
import {
  ArrowLeft,
  GitCommit,
  GitPullRequest,
  Shield,
  Layers,
  Clock,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SeverityBadge } from "@/components/ui/severity-badge";
import { TimeAgo } from "@/components/time-ago";
import { ScanComparisonView, type ScanOption } from "@/components/scans/scan-comparison-view";
import { compareScans, type ComparableScanInput } from "@/lib/scans/comparison";

export const dynamic = "force-dynamic";

function isGateConfigPartial(gateConfig: unknown): boolean {
  if (!gateConfig || typeof gateConfig !== "object") return false;
  const gc = gateConfig as Record<string, unknown>;
  if (gc.isPartialScan === true) return true;
  if (Array.isArray(gc.skippedFiles) && gc.skippedFiles.length > 0) return true;
  return false;
}

function toComparableInput(s: any): ComparableScanInput {
  return {
    id: s.id,
    headSha: s.headSha,
    createdAt: s.createdAt,
    riskScore: s.riskScore,
    policyDecision: s.policyDecision,
    findings: s.findings || [],
    isPartial: isGateConfigPartial(s.gateConfig),
    status: "COMPLETED",
  };
}

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const { id } = await params;

  const scan = await prisma.scanResult.findFirst({
    where: {
      id,
      pullRequest: {
        repository: {
          userId: session.user.id,
        },
      },
    },
    include: {
      findings: true,
      pullRequest: {
        include: {
          repository: true,
          scans: {
            orderBy: { createdAt: "desc" },
            include: { findings: true },
          },
        },
      },
    },
  });

  if (!scan) {
    notFound();
  }

  const pr = scan.pullRequest;
  const allPrScans = pr.scans;

  const scanOptions: ScanOption[] = allPrScans.map((s: any) => ({
    id: s.id,
    headSha: s.headSha,
    createdAt: s.createdAt,
    riskScore: s.riskScore,
    policyDecision: s.policyDecision,
    findingsCount: s.findings.length,
    isPartial: isGateConfigPartial(s.gateConfig),
  }));

  // Find previous scan of this PR for comparison (the one right after this one in descending date order)
  const currentIndex = allPrScans.findIndex((s: any) => s.id === scan.id);
  const previousScan =
    currentIndex >= 0 && currentIndex < allPrScans.length - 1
      ? allPrScans[currentIndex + 1]
      : allPrScans.length > 1
        ? allPrScans[1]
        : null;

  let initialComparison = null;
  if (previousScan) {
    initialComparison = compareScans(
      toComparableInput(previousScan), // base (earlier)
      toComparableInput(scan), // target (this scan)
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6">
      {/* Navigation header */}
      <div className="flex items-center justify-between">
        <Link
          href={`/dashboard/pull-requests/${pr.id}`}
          className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to PR #{pr.prNumber}
        </Link>
        <Link href={`/dashboard/pull-requests/${pr.id}`}>
          <Button variant="outline" size="sm" className="gap-2 text-xs">
            <GitPullRequest className="w-3.5 h-3.5" />
            Pull Request View
          </Button>
        </Link>
      </div>

      {/* Scan Overview Card */}
      <Card className="border-border/60 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <GitCommit className="w-5 h-5 text-primary" />
                <CardTitle className="text-xl font-bold tracking-tight">
                  Scan for commit {scan.headSha ? scan.headSha.slice(0, 7) : "unknown"}
                </CardTitle>
                <Badge
                  variant="outline"
                  className={
                    scan.policyDecision === "PASS"
                      ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                      : scan.policyDecision === "BLOCK"
                        ? "border-red-500/30 text-red-400 bg-red-500/10"
                        : "border-yellow-500/30 text-yellow-400 bg-yellow-500/10"
                  }
                >
                  Policy: {scan.policyDecision || "REVIEW"}
                </Badge>
                {isGateConfigPartial(scan.gateConfig) && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                    Partial Scan
                  </Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
                <Link
                  href={`/dashboard/pull-requests/${pr.id}`}
                  className="font-semibold text-primary hover:underline flex items-center gap-1"
                >
                  <GitPullRequest className="w-3 h-3" />
                  {pr.repository.fullName} #{pr.prNumber} - {pr.title}
                </Link>
                <span className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  Scanned <TimeAgo date={scan.createdAt} />
                </span>
                <span className="flex items-center gap-1">
                  <Shield className="w-3.5 h-3.5" />
                  Risk score: {scan.riskScore}
                </span>
                <span className="flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5" />
                  {scan.findings.length} findings
                </span>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Compare with Previous Scan Section */}
      <ScanComparisonView
        pullRequestId={pr.id}
        initialComparison={initialComparison}
        scans={scanOptions}
        pullRequestInfo={{
          id: pr.id,
          prNumber: pr.prNumber,
          title: pr.title,
          repositoryFullName: pr.repository.fullName,
        }}
      />

      {/* Findings detected in this scan */}
      <Card className="border-border/60 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Findings in This Scan ({scan.findings.length})
          </CardTitle>
          <CardDescription>
            All security findings detected in commit {scan.headSha ? scan.headSha.slice(0, 7) : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {scan.findings.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/80 p-8 text-center text-sm text-muted-foreground">
              No security findings detected in this scan! Clean code. 🎉
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {scan.findings.map((f: any) => (
                <div
                  key={f.id}
                  className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={f.severity} />
                    <Badge variant="outline" className="text-xs">
                      {f.type}
                    </Badge>
                    <span className="font-mono text-xs text-foreground/90 font-medium">
                      {f.fileLocation}
                      {f.lineStart ? `:${f.lineStart}` : ""}
                    </span>
                  </div>

                  <Link
                    href={`/dashboard/findings/${f.id}`}
                    className="text-primary hover:underline font-medium text-xs flex items-center gap-1 self-start sm:self-auto"
                  >
                    View finding
                    <ExternalLink className="w-3 h-3" />
                  </Link>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
