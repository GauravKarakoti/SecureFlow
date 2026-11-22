"use client";

import { useMemo, useState } from "react";
import CountUp from "react-countup";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ShieldAlert,
  Info,
  CheckCircle2,
  AlertOctagon,
  Terminal,
  Download,
  ExternalLink,
  FileText,
  Clock,
  AlertCircle,
  X,
  MessageSquare,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { calculateHeistRiskScore, calculateVaultIntegrity } from "@/lib/reports/shareable-report";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SeverityBadge } from "@/components/ui/severity-badge";
import StreamingExplanation from "@/components/streaming-explanation";
import FindingTriageControls, { BulkTriageBar } from "./finding-triage-controls";
import BulkRemediationBar from "./bulk-remediation-bar";
import FindingsPagination from "./findings-pagination";
import FindingsToolbar from "./findings-toolbar";
import FindingAudioPlayer from "@/components/findings/finding-audio-player";
import { SbomReportCard } from "@/components/findings/sbom-report-card"; // [NEW] Import SBOM Card
import type { TriageStatus, DismissalReason } from "@/lib/actions/triage";
import {
  getUserFindings,
  type FindingFilterOptions,
  type FindingRow,
  type FindingsStats,
} from "@/lib/actions/findings";
import type { SbomScanResult } from "@/types/sbom"; // [NEW] Import SBOM Type
import { TimeAgo } from "@/components/time-ago";
import { formatAgeDays } from "@/lib/findings/age";
import type { SavedViewDto } from "@/lib/actions/saved-views";
import { detectFileLanguage } from "@/lib/scanner/language-detector";

const TRIAGE_LABELS: Record<string, string> = {
  OPEN: "Open",
  DISMISSED: "Dismissed",
  RESOLVED: "Resolved",
  FALSE_POSITIVE: "False positive (legacy)",
  IGNORED: "Ignored (legacy)",
};

/**
 * `findings` was typed `any[]`, so the page's data contract lived only in the
 * shape of the object the server component happened to build. `FindingRow` is
 * that contract, exported from the action module that produces it.
 */
interface FindingsClientProps {
  findings: FindingRow[];
  stats: FindingsStats;
  filterOptions: FindingFilterOptions;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  nextCursor?: string | null;
  sbomReport?: SbomScanResult | null; // [NEW] Optional SBOM Report prop
  savedViews?: SavedViewDto[];
}

export default function FindingsClient({
  findings,
  stats,
  filterOptions,
  page,
  pageSize,
  total,
  totalPages,
  nextCursor,
  sbomReport, // [NEW] Destructure SBOM report
  savedViews = [],
}: FindingsClientProps) {
  const [prevFindings, setPrevFindings] = useState(findings);
  const [displayedFindings, setDisplayedFindings] = useState<FindingRow[]>(findings);
  const [cursor, setCursor] = useState<string | null | undefined>(nextCursor);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nowMs] = useState(() => Date.now());

  if (findings !== prevFindings) {
    setPrevFindings(findings);
    setDisplayedFindings(findings);
    setCursor(nextCursor);
  }

  // Bulk triage (#732). Selection is keyed by finding id, but each selected
  // finding resolves to a (repositoryId, fingerprint) target for the action.
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Export every finding matching the current filters, not just this page:
  // `/api/findings/export` reads the same query string as this page and streams
  // the full result. Paging parameters are dropped because the export has none.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasFilters = Boolean(
    searchParams?.get("q") ||
    searchParams?.get("severity") ||
    searchParams?.get("type") ||
    searchParams?.get("status") ||
    searchParams?.get("repo") ||
    searchParams?.get("from") ||
    searchParams?.get("to"),
  );
  const exportHref = useMemo(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("page");
    params.delete("pageSize");
    const query = params.toString();
    return `/api/findings/export${query ? `?${query}` : ""}`;
  }, [searchParams]);

  const jsonExportHref = useMemo(() => {
    const separator = exportHref.includes("?") ? "&" : "?";
    return `${exportHref}${separator}format=json`;
  }, [exportHref]);

  const heistRisk = useMemo(
    () =>
      calculateHeistRiskScore({
        critical: stats.criticalSecrets,
        high: stats.vulnerabilities,
        medium: stats.misconfigs,
        low: stats.other,
      }),
    [stats],
  );

  const vaultIntegrity = useMemo(
    () =>
      calculateVaultIntegrity({
        critical: stats.criticalSecrets,
        high: stats.vulnerabilities,
        medium: stats.misconfigs,
        low: stats.other,
      }),
    [stats],
  );

  const handleLoadMore = async () => {
    if (!cursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const res = await getUserFindings({
        cursor,
        pageSize,
        repositoryId: searchParams?.get("repo") ?? undefined,
        search: searchParams?.get("q") ?? undefined,
        severity: searchParams?.getAll("severity"),
        type: searchParams?.getAll("type"),
        status: searchParams?.getAll("status"),
        sort: searchParams?.get("sort") ?? undefined,
      });
      setDisplayedFindings((prev) => [...prev, ...res.findings]);
      setCursor(res.nextCursor);
    } catch (err) {
      console.error("Failed to load more findings:", err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Only findings that carry both a repositoryId and a fingerprint can be
  // triaged, so those are the only ones selectable.
  const selectableIds = useMemo(
    () => displayedFindings.filter((f) => f.repositoryId && f.fingerprint).map((f) => f.id),
    [displayedFindings],
  );

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };

  const clearSelection = () => setSelected(new Set());

  const enterBulkMode = () => setBulkMode(true);
  const exitBulkMode = () => {
    setBulkMode(false);
    clearSelection();
  };

  const bulkTargets = useMemo(
    () =>
      displayedFindings
        .filter((f) => selected.has(f.id) && f.repositoryId && f.fingerprint)
        .map((f) => ({ repositoryId: f.repositoryId!, fingerprint: f.fingerprint! })),
    [displayedFindings, selected],
  );

  const selectedFindings = useMemo(
    () => displayedFindings.filter((f) => selected.has(f.id)),
    [displayedFindings, selected],
  );

  return (
    <div className="space-y-8 w-full animate-in fade-in duration-700">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">
          Security Center
        </span>

        <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
          Security Findings
        </h1>

        <p className="mt-2 max-w-2xl text-muted-foreground">
          Review detected threats, vulnerabilities, and repository security insights across your
          organization.
        </p>
        <p className="text-muted-foreground">
          Analysis of all detected issues across your organization.
        </p>
      </div>

      {/* Four tiles, not three. Every finding lands in exactly one bucket, so a
          type the model spelled in a way nobody has catalogued yet shows up as
          "Other" instead of being counted nowhere while sitting in the list
          below (#590). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
        <StatBox
          icon={<AlertOctagon />}
          value={stats.criticalSecrets}
          label="Critical Secrets"
          color="red"
        />
        <StatBox
          icon={<ShieldAlert />}
          value={stats.vulnerabilities}
          label="Vulnerabilities"
          color="orange"
        />
        <StatBox icon={<Info />} value={stats.misconfigs} label="Misconfigs" color="blue" />
        <StatBox icon={<Terminal />} value={stats.other} label="Other" color="slate" />
      </div>

      {/* Themed Heist Risk & Vault Integrity Status (#1711) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-xl bg-gradient-to-r from-[#5A29E4]/15 via-[#5A29E4]/5 to-transparent border border-[#5A29E4]/30 glass-card flex items-center justify-between">
          <div>
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-violet-400">
              Heist Risk Score
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-headline font-bold text-foreground">
                {heistRisk.score}
              </span>
              <span className="text-xs font-mono text-muted-foreground">/ 100 Index</span>
            </div>
          </div>
          <Badge className="bg-[#5A29E4]/25 text-violet-300 border-[#5A29E4]/40 font-mono text-xs">
            {heistRisk.level}
          </Badge>
        </div>

        <div className="p-4 rounded-xl bg-gradient-to-r from-[#0A5C3E]/20 via-[#0A5C3E]/5 to-transparent border border-[#0A5C3E]/40 glass-card flex items-center justify-between">
          <div>
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-400">
              Vault Integrity Status
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-2xl font-headline font-bold text-foreground">
                {vaultIntegrity.percentage}%
              </span>
              <span className="text-xs font-mono text-muted-foreground">Defense Posture</span>
            </div>
          </div>
          <Badge className="bg-[#0A5C3E] text-emerald-100 border-emerald-500/40 font-mono text-xs">
            {vaultIntegrity.status}
          </Badge>
        </div>
      </div>

      {sbomReport && (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-blue-500" />
            Dependency Security
          </h2>
          <SbomReportCard result={sbomReport} />
        </div>
      )}

      <FindingsToolbar
        options={filterOptions}
        total={total}
        bulkMode={bulkMode}
        onToggleBulkMode={bulkMode ? exitBulkMode : enterBulkMode}
        canBulkSelect={selectableIds.length > 0}
        savedViews={savedViews}
      />

      <Card className="glass-card">
        <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <CardTitle className="text-lg">Recent Findings</CardTitle>

          <div className="flex flex-wrap items-center gap-2">
            {total === 0 ? (
              <>
                <Button variant="outline" size="sm" disabled className="gap-2 min-h-[44px]">
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
                <Button variant="outline" size="sm" disabled className="gap-2 min-h-[44px]">
                  <Download className="h-4 w-4" />
                  Export JSON
                </Button>
                <Button variant="outline" size="sm" disabled className="gap-2 min-h-[44px]">
                  <FileText className="h-4 w-4" />
                  Shareable Report
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="outline" size="sm" className="gap-2 min-h-[44px]">
                  {/* A link, not an onClick over `findings`: that is only the loaded
                      page, while the export should cover the `total` beside it. */}
                  <a href={exportHref} download>
                    <Download className="h-4 w-4" />
                    Export CSV
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" className="gap-2 min-h-[44px]">
                  <a href={jsonExportHref} download>
                    <Download className="h-4 w-4" />
                    Export JSON
                  </a>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="gap-2 min-h-[44px] border-[#5A29E4]/40 hover:border-[#5A29E4] bg-[#5A29E4]/10 text-violet-300"
                >
                  <a
                    href={`${exportHref}${exportHref.includes("?") ? "&" : "?"}format=html`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <FileText className="h-4 w-4" />
                    Shareable Report
                  </a>
                </Button>
              </>
            )}

            <Badge variant="outline" className="border-primary/20 bg-primary/5 text-primary">
              {/* The filtered total, not findings.length -- which was the page size and
                  read "50 Findings" on every account with more than fifty. */}
              {total.toLocaleString()} {total === 1 ? "Finding" : "Findings"}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="min-h-[520px]">
          {displayedFindings.length === 0 ? (
            <div className="flex min-h-[520px] flex-col items-center justify-center text-center">
              <ShieldAlert className="mb-5 h-16 w-16 text-red-500 opacity-70" />

              <h3 className="text-2xl font-bold">
                {hasFilters ? "No findings match these filters" : "No Security Findings"}
              </h3>

              <p className="mt-3 max-w-md text-sm text-muted-foreground">
                {hasFilters
                  ? "Every finding is filtered out by the current selection."
                  : "Great news! Your repositories are currently secure."}
              </p>

              <p className="mt-2 text-xs text-muted-foreground">
                {hasFilters
                  ? "Clear the filters above to see the full list again."
                  : "Continue scanning your repositories to detect future vulnerabilities."}
              </p>

              {hasFilters && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 gap-2"
                  onClick={() => {
                    const params = new URLSearchParams(searchParams?.toString() ?? "");
                    for (const key of [
                      "severity",
                      "type",
                      "status",
                      "repo",
                      "q",
                      "from",
                      "to",
                      "page",
                    ]) {
                      params.delete(key);
                    }
                    const query = params.toString();
                    const navigate = router.push ?? router.replace;
                    navigate.call(router, query ? `${pathname}?${query}` : pathname, {
                      scroll: false,
                    });
                  }}
                >
                  <X className="h-4 w-4" />
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {bulkMode && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all findings on this page"
                    />
                    <span>{allSelected ? "Deselect all" : "Select all on this page"}</span>
                  </div>
                  {bulkTargets.length > 0 && (
                    <div className="space-y-4">
                      <BulkTriageBar targets={bulkTargets} onDone={clearSelection} />
                      <BulkRemediationBar
                        selectedFindings={selectedFindings}
                        onClearSelection={clearSelection}
                      />
                    </div>
                  )}
                </div>
              )}
              <Accordion
                type="single"
                collapsible
                className="space-y-4"
                data-testid="findings-table"
              >
                {displayedFindings.map((finding) => {
                  const selectable = Boolean(finding.repositoryId && finding.fingerprint);
                  const expiryDate = finding.triageExpiresAt
                    ? new Date(finding.triageExpiresAt)
                    : null;
                  const isExpired = expiryDate ? expiryDate.getTime() <= nowMs : false;

                  return (
                    <AccordionItem
                      key={finding.id}
                      value={finding.id}
                      data-testid="finding-row"
                      className="border border-white/10 rounded-xl overflow-hidden px-4 transition-all duration-300 hover:border-primary/40 hover:shadow-lg"
                    >
                      <div className="flex items-center gap-3">
                        {bulkMode && selectable && (
                          <Checkbox
                            checked={selected.has(finding.id)}
                            onCheckedChange={() => toggleOne(finding.id)}
                            aria-label={`Select finding in ${finding.fileLocation}`}
                            className="shrink-0 min-h-[20px] min-w-[20px]"
                          />
                        )}
                        <AccordionTrigger className="flex-1 hover:no-underline py-4">
                          <div className="flex flex-col md:flex-row md:items-center gap-2.5 md:gap-4 w-full text-left pr-2 md:pr-0">
                            {/* On mobile: flex header row. On desktop: contents unwraps children into the row */}
                            <div className="flex items-start justify-between md:contents gap-2">
                              <div className="flex-1 min-w-0" data-testid="finding-file">
                                <div className="font-bold text-sm mb-0.5 truncate">
                                  {finding.type} Detected
                                </div>
                                <div className="text-[10px] font-mono text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 break-all">
                                  <span>{finding.fileLocation}</span>
                                  <Badge
                                    variant="outline"
                                    className="border-white/15 bg-white/5 text-muted-foreground font-mono text-[10px] shrink-0 capitalize py-0 px-1.5 h-4"
                                    data-testid="finding-language"
                                  >
                                    {finding.language || detectFileLanguage(finding.fileLocation).language}
                                  </Badge>
                                  {finding.createdAt && (
                                    <>
                                      <span>•</span>
                                      <TimeAgo date={finding.createdAt} />
                                    </>
                                  )}
                                  <span className="inline-flex md:hidden items-center gap-1">
                                    <span>•</span>
                                    <Clock className="w-3 h-3" />
                                    {formatAgeDays(finding.createdAt)}
                                  </span>
                                </div>
                              </div>
                              <div data-testid="finding-severity" className="shrink-0 md:order-5">
                                <SeverityBadge
                                  severity={finding.severity}
                                  title={`Raw severity: ${finding.severity}`}
                                />
                              </div>
                            </div>

                            {/* Badges: wrapped row on mobile, inline on desktop */}
                            <div className="flex flex-wrap items-center gap-1.5 pt-0.5 md:pt-0 md:contents">
                              {finding.promptInjectionSuspected && (
                                <Badge
                                  className="bg-yellow-500 text-black shrink-0 text-[10px]"
                                  title="The scanned code may contain content crafted to influence the AI explanation. Trust the severity badge over the narrative below."
                                >
                                  ⚠️ Verify manually
                                </Badge>
                              )}
                              {finding.triageStatus && finding.triageStatus !== "OPEN" && (
                                <Badge
                                  variant="outline"
                                  className={
                                    finding.triageStatus === "RESOLVED"
                                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-mono text-[10px] shrink-0"
                                      : "border-white/15 bg-white/5 text-muted-foreground font-mono text-[10px] shrink-0"
                                  }
                                  title={
                                    finding.triageStatus === "RESOLVED" && finding.resolvedCommitSha
                                      ? `Resolved by commit ${finding.resolvedCommitSha}`
                                      : "Triage status"
                                  }
                                >
                                  {finding.triageStatus === "RESOLVED" && finding.resolvedCommitSha
                                    ? `resolved by commit ${finding.resolvedCommitSha.slice(0, 7)}`
                                    : (TRIAGE_LABELS[finding.triageStatus] ?? finding.triageStatus)}
                                </Badge>
                              )}
                              {expiryDate && (
                                <Badge
                                  variant="outline"
                                  className={
                                    isExpired
                                      ? "border-red-500/20 bg-red-500/10 text-red-400 font-mono text-[10px] shrink-0"
                                      : "border-amber-500/20 bg-amber-500/10 text-amber-300 font-mono text-[10px] shrink-0"
                                  }
                                  title={`Dismissal expiry: ${expiryDate.toLocaleDateString()}`}
                                >
                                  <Clock className="w-3 h-3 mr-1 inline" />
                                  {isExpired
                                    ? "expired"
                                    : `expires on ${expiryDate.toLocaleDateString()}`}
                                </Badge>
                              )}
                              {finding.triageNote?.includes("previous dismissal expired on") && (
                                <Badge
                                  variant="outline"
                                  className="border-amber-500/30 bg-amber-500/10 text-amber-300 font-mono text-[10px] shrink-0"
                                >
                                  ⚠️ {finding.triageNote}
                                </Badge>
                              )}
                              {/* Overdue badge */}
                              {finding.isOverdue && (
                                <Badge
                                  className="bg-red-600/80 text-white border-red-500/60 font-mono text-[10px] animate-pulse shrink-0"
                                  title="This finding has exceeded its target resolution age"
                                >
                                  <AlertCircle className="w-3 h-3 mr-1" />
                                  Overdue
                                </Badge>
                              )}
                              {/* Reviewer discussion note count badge (#1920) */}
                              {Boolean(finding.noteCount && finding.noteCount > 0) && (
                                <Badge
                                  variant="outline"
                                  className="border-blue-500/30 bg-blue-500/10 text-blue-400 font-mono text-[10px] shrink-0 inline-flex items-center gap-1"
                                  title={`${finding.noteCount} ${finding.noteCount === 1 ? "reviewer note" : "reviewer notes"}`}
                                  data-testid="finding-note-count"
                                >
                                  <MessageSquare className="w-3 h-3" />
                                  <span>{finding.noteCount}</span>
                                </Badge>
                              )}
                            </div>

                            {/* Age column on desktop */}
                            <span
                              className="hidden md:inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground shrink-0 md:order-4"
                              title="Finding age"
                            >
                              <Clock className="w-3 h-3" />
                              {formatAgeDays(finding.createdAt)}
                            </span>

                            {/* Action row on mobile / button on desktop */}
                            <div className="flex items-center justify-between md:justify-end w-full md:w-auto pt-1 md:pt-0 md:order-6">
                              <span className="text-[11px] text-muted-foreground font-mono md:hidden">
                                Tap to view triage &amp; AI patch
                              </span>
                              <Link
                                href={`/dashboard/findings/${finding.id}`}
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-mono transition-colors px-2 py-1 rounded-md hover:bg-white/5 border border-transparent hover:border-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[44px] shrink-0"
                                title="View finding permalink"
                                aria-label={`View finding ${finding.id} details`}
                              >
                                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">Details</span>
                              </Link>
                            </div>
                          </div>
                        </AccordionTrigger>
                      </div>
                      <AccordionContent className="pb-6 pt-2">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 px-4">
                          <div className="space-y-6">
                            <FindingAudioPlayer
                              findingId={finding.id}
                              findingType={finding.type}
                              severity={finding.severity}
                            />

                            {finding.promptInjectionSuspected && (
                              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 text-xs text-yellow-200">
                                ⚠️{" "}
                                <strong>
                                  AI explanation may be unreliable for this finding — verify
                                  manually.
                                </strong>{" "}
                                The scanned code may contain content crafted to look like
                                instructions. The severity badge is set by the static scanner and is
                                not affected by this.
                              </div>
                            )}
                            <StreamingExplanation
                              findingId={finding.id}
                              storedExplanation={finding.explanation || "No explanation provided."}
                            />

                            <div>
                              <h4 className="text-xs font-bold text-green-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                                <CheckCircle2 className="w-3 h-3" /> Remediation Steps
                              </h4>
                              <div className="text-sm text-muted-foreground leading-relaxed p-4 bg-white/5 border border-white/5 rounded-xl">
                                {finding.remediation ||
                                  "Follow standard security practices to resolve this."}
                              </div>
                            </div>

                            {finding.repositoryId && finding.fingerprint && (
                              <FindingTriageControls
                                repositoryId={finding.repositoryId}
                                fingerprint={finding.fingerprint}
                                currentStatus={(finding.triageStatus ?? "OPEN") as TriageStatus}
                                currentNote={finding.triageNote ?? null}
                                currentReason={finding.triageReason as DismissalReason | null}
                                currentExpiresAt={finding.triageExpiresAt}
                              />
                            )}
                          </div>

                          <div className="space-y-4">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="text-xs font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
                                <Terminal className="w-3 h-3" /> Source Context
                              </h4>
                              <Link
                                href={`/dashboard/findings/${finding.id}`}
                                className="text-xs text-primary hover:underline inline-flex items-center gap-1 font-mono"
                              >
                                Side-by-side review & fix &rarr;
                              </Link>
                            </div>
                            <div className="rounded-xl border border-primary/20 bg-black/60 p-6 font-mono text-[11px] text-primary overflow-x-auto whitespace-pre shadow-inner">
                              {finding.codeSnippet || "Code snippet unavailable."}
                            </div>
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </div>
          )}
        </CardContent>

        {cursor && (
          <div className="flex justify-center p-4 border-t border-foreground/10">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadMore}
              disabled={isLoadingMore}
              aria-label="Load more findings"
            >
              {isLoadingMore ? "Loading..." : "Load more findings"}
            </Button>
          </div>
        )}

        <FindingsPagination page={page} pageSize={pageSize} total={total} totalPages={totalPages} />
      </Card>
    </div>
  );
}

function StatBox({
  icon,
  value,
  label,
  color,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  color: "red" | "orange" | "blue" | "slate";
}) {
  const styles = {
    red: {
      border: "border-red-500/20",
      bg: "bg-red-500/10",
      text: "text-red-400",
    },
    orange: {
      border: "border-orange-500/20",
      bg: "bg-orange-500/10",
      text: "text-orange-400",
    },
    blue: {
      border: "border-blue-500/20",
      bg: "bg-blue-500/10",
      text: "text-blue-400",
    },
    // Deliberately the least alarming of the four. "Other" is an
    // unclassified finding, not a more severe one.
    slate: {
      border: "border-slate-500/20",
      bg: "bg-slate-500/10",
      text: "text-slate-400",
    },
  };

  const theme = styles[color];

  return (
    <Card
      className={`glass-card group overflow-hidden transition-all duration-300
      hover:-translate-y-2
      hover:shadow-2xl
      hover:border-primary/40
      cursor-pointer
      ${theme.border}`}
    >
      <CardContent className="flex flex-col items-center p-6">
        <div
          className={`mb-4 flex h-14 w-14 items-center justify-center rounded-full
          ${theme.bg} ${theme.text}
          transition-all duration-300
          group-hover:scale-110
          group-hover:rotate-6`}
        >
          {icon}
        </div>

        <h3 className="text-4xl font-bold">
          <CountUp end={value} duration={1.8} />
        </h3>

        <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </p>
      </CardContent>
    </Card>
  );
}
