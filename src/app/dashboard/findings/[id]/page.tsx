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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSeverityTheme } from "@/lib/severity-theme";
import { maskSecrets } from "@/lib/armor/secret-masking";
import FindingAudioPlayer from "@/components/findings/finding-audio-player";
import StreamingExplanation from "@/components/streaming-explanation";
import FindingActions from "./finding-actions";
import type { TriageStatus } from "@/lib/triage/statuses";

export const dynamic = "force-dynamic";

export default async function FindingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const { id } = await params;

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

  // Mask secrets in code snippet
  const maskedSnippet = finding.codeSnippet ? maskSecrets(finding.codeSnippet) : null;

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6">
      {/* Navigation header */}
      <div className="flex items-center justify-between">
        <Link
          href="/dashboard/findings"
          className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Findings
        </Link>
        <Link href={`/dashboard/findings/${finding.id}/remediation`}>
          <Button size="sm" className="gap-2">
            <Wrench className="w-3.5 h-3.5" />
            AI Remediation
          </Button>
        </Link>
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
                <Badge className={theme.badgeClass}>{theme.label}</Badge>
                {policyDecision && (
                  <Badge variant="outline" className="text-xs border-white/20 gap-1">
                    <Shield className="w-3 h-3" />
                    Policy: {policyDecision}
                  </Badge>
                )}
                {finding.promptInjectionSuspected && (
                  <Badge className="bg-yellow-500 text-black">⚠️ Verify manually</Badge>
                )}
              </div>
              <p className="text-xs font-mono text-muted-foreground flex flex-wrap items-center gap-2">
                <span>{repoName}</span>
                <span>•</span>
                <span>PR #{prNumber}</span>
                <span>•</span>
                <span className="flex items-center gap-1">
                  <FileCode className="w-3 h-3" />
                  {finding.fileLocation}
                  {lineInfo && <span className="text-primary font-semibold">({lineInfo})</span>}
                </span>
              </p>
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="space-y-6">
              {/* AI Security Explanation */}
              <StreamingExplanation
                findingId={finding.id}
                storedExplanation={finding.explanation || "No explanation provided."}
              />

              {/* Remediation Steps */}
              <div>
                <h4 className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <CheckCircle2 className="w-3 h-3" /> Remediation Guidance
                </h4>
                <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-white/5 border border-white/5 rounded-xl">
                  {finding.remediation ||
                    "Follow standard security practices to sanitize input and isolate privileges."}
                </div>
              </div>
            </div>

            {/* Source Context Snippet (with secrets redacted) */}
            <div className="space-y-4">
              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-2">
                <Terminal className="w-3 h-3" /> Source Context
                {lineInfo && (
                  <span className="text-xs font-mono text-primary/80 lowercase">({lineInfo})</span>
                )}
              </h4>
              <div className="rounded-xl border border-primary/20 bg-black/60 p-6 font-mono text-[11px] text-primary overflow-x-auto whitespace-pre shadow-inner">
                {maskedSnippet || "Code snippet unavailable."}
              </div>
            </div>
          </div>

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
                        <span className="font-mono text-muted-foreground">
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
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
