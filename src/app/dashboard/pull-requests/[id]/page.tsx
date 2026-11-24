import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import prisma from "@/lib/prisma";
import Link from "next/link";
import {
  ArrowLeft,
  GitPullRequest,
  Shield,
  Clock,
  User,
  History,
  CheckCircle2,
  AlertOctagon,
  Layers,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

export default async function PullRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const { id } = await params;

  const pr = await prisma.pullRequest.findFirst({
    where: {
      id,
      repository: {
        userId: session.user.id,
      },
    },
    include: {
      repository: true,
      scans: {
        orderBy: { createdAt: "desc" },
        include: {
          findings: true,
        },
      },
    },
  });

  if (!pr) {
    notFound();
  }

  const scanOptions: ScanOption[] = pr.scans.map((s: any) => ({
    id: s.id,
    headSha: s.headSha,
    createdAt: s.createdAt,
    riskScore: s.riskScore,
    policyDecision: s.policyDecision,
    findingsCount: s.findings.length,
    isPartial: isGateConfigPartial(s.gateConfig),
  }));

  let initialComparison = null;
  if (pr.scans.length >= 2) {
    initialComparison = compareScans(
      toComparableInput(pr.scans[1]), // earlier scan (base)
      toComparableInput(pr.scans[0]), // latest scan (target)
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6">
      {/* Navigation header */}
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Dashboard
        </Link>
        <Link href={`/dashboard/findings?repo=${pr.repository.id}`}>
          <Button variant="outline" size="sm" className="gap-2 text-xs">
            <Shield className="w-3.5 h-3.5" />
            Repository Findings
          </Button>
        </Link>
      </div>

      {/* PR Header Card */}
      <Card className="border-border/60 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <GitPullRequest className="w-5 h-5 text-primary" />
                <CardTitle className="text-xl font-bold tracking-tight">{pr.title}</CardTitle>
                <Badge variant="secondary" className="font-mono text-xs">
                  #{pr.prNumber}
                </Badge>
                <Badge
                  variant="outline"
                  className={
                    pr.status === "PASS"
                      ? "border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
                      : pr.status === "BLOCKED"
                        ? "border-red-500/30 text-red-400 bg-red-500/10"
                        : "border-yellow-500/30 text-yellow-400 bg-yellow-500/10"
                  }
                >
                  {pr.status}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
                <span className="font-semibold text-foreground/80">{pr.repository.fullName}</span>
                {pr.authorLogin && (
                  <span className="flex items-center gap-1">
                    <User className="w-3.5 h-3.5" />
                    {pr.authorLogin}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" />
                  Opened <TimeAgo date={pr.createdAt} />
                </span>
                <span className="flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5" />
                  {pr.scans.length} scan{pr.scans.length === 1 ? "" : "s"} recorded
                </span>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Scan Comparison View */}
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

      {/* History of All Scans for this PR */}
      <Card className="border-border/60 bg-card/60 backdrop-blur-md">
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            Scan History ({pr.scans.length})
          </CardTitle>
          <CardDescription>
            All recorded security scans triggered by push events on this pull request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border/40">
            {pr.scans.map((scan: any, idx: number) => (
              <div
                key={scan.id}
                className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="font-mono text-xs">
                    {scan.headSha ? scan.headSha.slice(0, 7) : "unknown"}
                  </Badge>
                  <div>
                    <span className="font-medium text-xs">
                      {idx === 0 ? "Latest push" : `Push #${pr.scans.length - idx}`}
                    </span>
                    <span className="text-muted-foreground text-xs ml-2">
                      <TimeAgo date={scan.createdAt} />
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground">
                    Findings: <strong>{scan.findings.length}</strong>
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      scan.policyDecision === "PASS"
                        ? "text-emerald-400 border-emerald-500/30"
                        : scan.policyDecision === "BLOCK"
                          ? "text-red-400 border-red-500/30"
                          : "text-yellow-400 border-yellow-500/30"
                    }
                  >
                    {scan.policyDecision || "REVIEW"}
                  </Badge>
                  <Link
                    href={`/dashboard/scans/${scan.id}`}
                    className="text-primary hover:underline font-medium text-xs ml-1"
                  >
                    View scan →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
