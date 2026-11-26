import { auth } from "@/auth";
import { redirect, notFound } from "next/navigation";
import prisma from "@/lib/prisma";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Terminal,
  Wrench,
  Shield,
  History,
  Clock,
  FileCode,
  GitPullRequest,
  ExternalLink,
} from "lucide-react";
import CreateIssueDialog from "@/components/findings/create-issue-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSeverityTheme } from "@/lib/severity-theme";
import { SeverityBadge } from "@/components/ui/severity-badge";
import { CweBadge } from "@/components/ui/cwe-badge";
import FindingAudioPlayer from "@/components/findings/finding-audio-player";
import StreamingExplanation from "@/components/streaming-explanation";
import CodeContextViewer from "@/components/findings/code-context-viewer";
import RemediationGuidanceCard from "@/components/findings/remediation-guidance-card";
import ShareFindingButton from "@/components/findings/share-finding-button";
import FindingActions from "./finding-actions";
import FindingNotesThread from "../finding-notes-thread";
import FindingAssigneeSelect from "../finding-assignee-select";
import type { TriageStatus } from "@/lib/triage/statuses";
import { TimeAgo } from "@/components/time-ago";
import { detectFileLanguage } from "@/lib/scanner/language-detector";
import { resolvePolicyGuidance } from "@/lib/policies/built-in";

export const dynamic = "force-dynamic";

export default async function FindingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const rawReturnTo = resolvedSearchParams?.returnTo;
  const returnTo =
    typeof rawReturnTo === "string" && rawReturnTo.startsWith("/dashboard/findings")
      ? rawReturnTo
      : "/dashboard/findings";

  const finding = await prisma.finding.findFirst({
    where: {
      id,
      scanResult: {
        pullRequest: {
          repository: { userId: session.user.id },
        },
      },
    },
    include: {
      scanResult: {
        include: {
          pullRequest: {
            include: {
              repository: true,
            },
          },
        },
      },
    },
  });

  if (!finding) {
    notFound();
  }

  const repo = finding.scanResult.pullRequest.repository;
  const triage = await prisma.findingTriage.findUnique({
    where: {
      repositoryId_fingerprint: {
        repositoryId: repo.id,
        fingerprint: finding.fingerprint,
      },
    },
    include: {
      assignee: {
        select: {
          id: true,
          name: true,
          email: true,
          codename: true,
          image: true,
        },
      },
    },
  });

  // Fetch status history / audit trail for this finding
  const auditLogs = await prisma.auditLog.findMany({
    where: {
      resource: `finding:${finding.id}`,
    },
    include: {
      user: {
        select: {
          name: true,
          email: true,
        },
      },
    },
    orderBy: {
      timestamp: "desc",
    },
    take: 20,
  });

  // Fetch reviewer discussion notes
  const notes = await prisma.findingNote.findMany({
    where: { findingId: finding.id },
    orderBy: { createdAt: "asc" },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          email: true,
          codename: true,
          image: true,
        },
      },
    },
  });

  const isAdmin = session.user.roles?.includes("ADMIN") ?? false;

  const theme = getSeverityTheme(finding.severity);
  const repoName = repo.fullName;
  const prNumber = finding.scanResult.pullRequest.prNumber;
  const policyDecision = finding.scanResult.policyDecision;

  // Format line information
  const lineInfo =
    finding.lineStart && finding.lineEnd && finding.lineStart !== finding.lineEnd
      ? `Lines ${finding.lineStart}-${finding.lineEnd}`
      : finding.lineStart
        ? `Line ${finding.lineStart}`
        : null;

  const detectedLang = detectFileLanguage(finding.fileLocation);
  const policyGuidance = resolvePolicyGuidance({
    type: finding.type,
    policyName: finding.scanResult.policyDecision,
  });

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6">
      {/* Navigation header */}
      <div className="flex items-center justify-between">
        <Link
          href={returnTo}
          className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Findings
        </Link>
        <div className="flex items-center gap-2">
          <CreateIssueDialog
            findingId={finding.id}
            existingIssueUrl={finding.issueUrl}
            variant="detail"
          />
          <ShareFindingButton findingId={finding.id} />
          <Link href={`/dashboard/pull-requests/${finding.scanResult.pullRequestId}`}>
            <Button size="sm" variant="outline" className="gap-2">
              <History className="w-3.5 h-3.5" />
              Compare Scans
            </Button>
          </Link>
          <Link href={`/dashboard/findings/${finding.id}/remediation`}>
            <Button size="sm" className="gap-2">
              <Wrench className="w-3.5 h-3.5" />
              AI Remediation
            </Button>
          </Link>
        </div>
      </div>

      {/* Main Finding Overview Card */}
      <Card className="border-white/10 bg-black/40 backdrop-blur-md">
        <CardHeader className="pb-4 border-b border-white/5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-3 mb-1">
                <CardTitle className="text-xl font-bold tracking-tight">
                  {finding.type} Detected
                </CardTitle>
                <SeverityBadge severity={finding.severity} />
                <CweBadge cwe={finding.cwe} />
                {policyDecision && (
                  <Badge variant="outline" className="text-xs border-white/20 gap-1">
                    <Shield className="w-3 h-3" />
                    Policy: {policyDecision}
                  </Badge>
                )}
                {finding.promptInjectionSuspected && (
                  <Badge className="bg-yellow-500 text-black">⚠️ Verify manually</Badge>
                )}
                {triage?.status === "RESOLVED" && (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono text-xs gap-1"
                  >
                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                    {triage.resolvedCommitSha
                      ? `Resolved by commit ${triage.resolvedCommitSha.slice(0, 7)}`
                      : "Resolved"}
                  </Badge>
                )}
                {finding.issueUrl && (
                  <a
                    href={finding.issueUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border border-purple-500/30 bg-purple-500/10 text-purple-300 font-mono text-xs gap-1 inline-flex items-center px-2.5 py-0.5 rounded-full hover:bg-purple-500/20 transition-colors"
                    title={`GitHub Issue: ${finding.issueUrl}`}
                    data-testid="finding-detail-issue-badge"
                  >
                    <GitPullRequest className="w-3.5 h-3.5 text-purple-400" />
                    <span>Issue #{finding.issueUrl.split("/").pop()}</span>
                    <ExternalLink className="w-3 h-3 ml-0.5 opacity-70" />
                  </a>
                )}
                {policyGuidance.helpUrl && (
                  <a
                    href={policyGuidance.helpUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 font-mono text-xs gap-1 inline-flex items-center px-2.5 py-0.5 rounded-full hover:bg-emerald-500/20 transition-colors"
                    title={policyGuidance.guidance || "How to fix guidance"}
                    data-testid="finding-detail-how-to-fix"
                  >
                    <span>How to fix</span>
                    <ExternalLink className="w-3.5 h-3.5 text-emerald-400" />
                  </a>
                )}
              </div>
              <div className="text-xs font-mono text-muted-foreground flex flex-wrap items-center gap-2">
                <span>{repoName}</span>
                <span>•</span>
                <Link
                  href={`/dashboard/pull-requests/${finding.scanResult.pullRequestId}`}
                  className="hover:text-primary transition-colors hover:underline"
                >
                  PR #{prNumber}
                </Link>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <FileCode className="w-3 h-3" />
                  {finding.fileLocation}
                  {lineInfo && <span className="text-primary font-semibold">({lineInfo})</span>}
                </span>
                <span>•</span>
                <Badge
                  variant="outline"
                  className="border-white/20 text-xs font-mono capitalize"
                  data-testid="finding-language"
                >
                  {detectedLang.language}
                </Badge>
                {detectedLang.framework && (
                  <Badge
                    variant="outline"
                    className="border-white/20 text-xs font-mono capitalize bg-white/5"
                    data-testid="finding-framework"
                  >
                    {detectedLang.framework}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-6 space-y-6">
          {/* Hands-Free Streaming Audio Debrief Player */}
          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">
              Audio Debrief
            </h4>
            <FindingAudioPlayer
              findingId={finding.id}
              findingType={finding.type}
              severity={finding.severity}
              autoFetch={false}
            />
          </div>

          {/* Interactive Triage & Management Actions (wired to /api/findings/[id]) */}
          <FindingActions
            findingId={finding.id}
            initialSeverity={finding.severity}
            initialTriageStatus={(triage?.status as TriageStatus) ?? "OPEN"}
            initialNote={triage?.note ?? ""}
          />

          {/* Finding Assignee Card / Action (#1921) */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border border-white/10 bg-white/[0.02] gap-3">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
                Assignee
              </h4>
              <p className="text-xs text-muted-foreground">
                Assign this finding to a team member with repository access.
              </p>
            </div>
            <FindingAssigneeSelect
              repositoryId={repo.id}
              fingerprint={finding.fingerprint}
              currentAssignee={triage?.assignee}
              variant="detail"
            />
          </div>

          {/* Side-by-Side Vulnerable Code & Remediation Review */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-primary" />
              Side-by-Side Review: Vulnerable Code & Fix
            </h3>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              {/* Left Column: Vulnerable Source Code with Line Numbers and Affected Lines Highlighted */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                  <Terminal className="w-3 h-3" /> Source Context
                  {lineInfo && (
                    <span className="text-xs font-mono text-primary/80 lowercase">
                      ({lineInfo})
                    </span>
                  )}
                </h4>
                <CodeContextViewer
                  codeSnippet={finding.codeSnippet}
                  lineStart={finding.lineStart}
                  lineEnd={finding.lineEnd}
                  fileLocation={finding.fileLocation}
                />
              </div>

              {/* Right Column: Suggested Fix / Remediation Guidance with Copy Button */}
              <div className="space-y-6">
                <RemediationGuidanceCard remediation={finding.remediation} />

                {/* AI Security Explanation */}
                <StreamingExplanation
                  findingId={finding.id}
                  storedExplanation={finding.explanation || "No explanation provided."}
                />
              </div>
            </div>
          </div>

          {/* Reviewer Discussion & Notes Thread (#1920) */}
          <FindingNotesThread
            findingId={finding.id}
            initialNotes={notes}
            currentUserId={session.user.id}
            isAdmin={isAdmin}
          />

          {/* Status History & Audit Trail */}
          <div className="pt-6 border-t border-white/5 space-y-4">
            <div className="flex items-center gap-2">
              <History className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                Status History & Audit Trail
              </h4>
            </div>

            {auditLogs.length === 0 ? (
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 text-xs text-muted-foreground font-mono">
                No status changes or audit events recorded for this finding yet.
              </div>
            ) : (
              <div className="space-y-2">
                {auditLogs.map((log: any) => {
                  const metadata = (log.metadata as Record<string, any>) || {};
                  return (
                    <div
                      key={log.id}
                      className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/5 text-xs gap-2"
                    >
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <TimeAgo date={log.timestamp} className="font-mono text-muted-foreground" />
                        <Badge variant="outline" className="text-[10px] font-mono uppercase">
                          {log.action}
                        </Badge>
                        {metadata.triageStatus && (
                          <span className="text-foreground font-medium">
                            Status:{" "}
                            <Badge variant="secondary" className="text-[10px]">
                              {metadata.triageStatus}
                            </Badge>
                          </span>
                        )}
                        {metadata.severity && (
                          <span className="text-muted-foreground">
                            Severity:{" "}
                            <span className="font-semibold text-foreground">
                              {metadata.severity}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground text-[11px]">
                        {metadata.note && (
                          <span className="italic max-w-xs truncate" title={metadata.note}>
                            &ldquo;{metadata.note}&rdquo;
                          </span>
                        )}
                        <span>by {log.user?.name || log.user?.email || "System"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
