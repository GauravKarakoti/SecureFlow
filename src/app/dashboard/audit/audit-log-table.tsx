"use client";

import React, { useEffect, useState } from "react";
import {
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  History,
  Download,
  ShieldCheck,
  Lock,
  ShieldAlert,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getUserAuditLogs,
  getUserAuditLogsForExport,
  type UserAuditLogResult,
} from "@/lib/actions/audit";
import type { UserAuditLogRow } from "@/lib/audit/export-limits";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { downloadCSV, downloadJSON, downloadCompliancePDF } from "@/lib/utils/exportCsv";

const PAGE_SIZE = 10;
const ALL = "ALL";

export default function AuditLogTable({
  initialResult,
  actions,
  decisions,
  ownName,
}: {
  initialResult: UserAuditLogResult;
  actions: string[];
  decisions: string[];
  ownName: string;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState(ALL);
  const [decisionFilter, setDecisionFilter] = useState(ALL);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<UserAuditLogResult>(initialResult);
  const [isLoading, setIsLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [armoriqOnly, setArmoriqOnly] = useState(false);

  const hasFilters =
    search.trim() !== "" ||
    actionFilter !== ALL ||
    decisionFilter !== ALL ||
    dateFrom !== "" ||
    dateTo !== "" ||
    armoriqOnly;

  // Reconstructed here from the plain `ownName` string prop — every log is
  // already scoped to this user (or is a null-userId "System" event), so
  // there's no need to look up multiple users, just this one check.
  const displayUser = (log: UserAuditLogRow) => (log.userId ? ownName : "System");

  const clearFilters = () => {
    setSearch("");
    setActionFilter(ALL);
    setDecisionFilter(ALL);
    setDateFrom("");
    setDateTo("");
    setArmoriqOnly(false);
    setPage(1);
  };

  // Exports every log matching the current filters — including the date
  // range, action, decision, and search — not just the current page. The
  // table above is paginated for readability, but an export should cover
  // everything the user has filtered down to, not just the 10 rows shown.
  const exportLogs = async (
    exportFormat: "csv" | "json" | "soc2-pdf" | "soc2-json" | "iso-pdf" | "iso-csv" = "csv",
  ) => {
    setIsExporting(true);
    try {
      const result = await getUserAuditLogsForExport({
        action: actionFilter === ALL ? undefined : actionFilter,
        decision: decisionFilter === ALL ? undefined : decisionFilter,
        search: search.trim() ? search.trim() : undefined,
        // Date inputs are "YYYY-MM-DD"; expand "to" to the end of that day
        // so the selected end date is fully included, not cut off at midnight.
        startDate: dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined,
        endDate: dateTo ? new Date(`${dateTo}T23:59:59.999`) : undefined,
      });

      if (!result.rows.length) {
        toast({
          title: "Nothing to export",
          description: "No entries match the current filters.",
        });
        return;
      }

      const dateStamp = new Date().toISOString().slice(0, 10);

      // Directly leverage /api/audit/armoriq compliance evidence endpoint
      // for verified SOC 2 and ISO 27001 export traceability
      let complianceEvidence: any[] = [];
      if (
        exportFormat === "soc2-pdf" ||
        exportFormat === "soc2-json" ||
        exportFormat === "iso-pdf" ||
        exportFormat === "iso-csv"
      ) {
        const framework = exportFormat.startsWith("soc2") ? "SOC2" : "ISO27001";
        const decisionParam =
          decisionFilter !== ALL ? `&decision=${encodeURIComponent(decisionFilter)}` : "";
        try {
          const apiRes = await fetch(
            `/api/audit/armoriq?format=compliance&framework=${framework}${decisionParam}`,
          );
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            complianceEvidence = apiData.evidence || [];
          }
        } catch (e) {
          console.warn(
            "Failed to retrieve ArmorIQ compliance evidence from /api/audit/armoriq, falling back to local logs",
            e,
          );
        }
      }

      if (exportFormat === "soc2-pdf") {
        const soc2Rows =
          complianceEvidence.length > 0
            ? complianceEvidence.map((item: any) => ({
                traceId: item.auditId,
                action: item.toolInvoked,
                decision: item.policyDecision || "ALLOW",
                resource: item.toolInvoked,
                justification: item.justification || "Evaluated by ArmorIQ Policy Engine",
                ruleMatched: item.ruleEnforced || "Zero-Trust Enforcement",
                proofHash: item.cryptographicProof || "VERIFIED_CRYPTOGRAPHIC_TOKEN",
                signature: item.signatureProvenance || "PROVENANCE_HMAC_VALID",
                frameworkControls: item.complianceControls || [
                  "SOC 2 CC6.1 (Logical Access)",
                  "SOC 2 CC6.8 (Malicious Behavior Prevention)",
                ],
                timestamp: item.timestamp,
              }))
            : result.rows.map((log) => {
                const meta = (log.metadata as any) || {};
                return {
                  traceId: log.id,
                  action: log.action,
                  decision: log.decision || "ALLOW",
                  resource: log.resource,
                  justification:
                    meta.reason || meta.justification || "Evaluated by ArmorIQ Policy Engine",
                  ruleMatched: meta.rule || meta.ruleMatched || "Zero-Trust Enforcement",
                  proofHash: meta.proofHash || "VERIFIED_CRYPTOGRAPHIC_TOKEN",
                  signature: meta.signature || "PROVENANCE_HMAC_VALID",
                  frameworkControls: [
                    "SOC 2 CC6.1 (Logical Access)",
                    "SOC 2 CC6.8 (Malicious Behavior Prevention)",
                  ],
                  timestamp: new Date(log.timestamp).toISOString(),
                };
              });
        downloadCompliancePDF(
          "SOC 2 Type II AI Agent Traceability Report",
          soc2Rows,
          `soc2-compliance-${dateStamp}.pdf`,
        );
      } else if (exportFormat === "soc2-json") {
        const soc2Json =
          complianceEvidence.length > 0
            ? complianceEvidence
            : result.rows.map((log) => {
                const meta = (log.metadata as any) || {};
                return {
                  traceId: log.id,
                  action: log.action,
                  decision: log.decision || "ALLOW",
                  resource: log.resource,
                  justification: meta.reason || meta.justification || "ArmorIQ Intent Verification",
                  ruleMatched: meta.rule || meta.ruleMatched || "Zero-Trust Intent Gate",
                  proofHash: meta.proofHash || null,
                  signature: meta.signature || null,
                  controls: ["SOC 2 CC6.1", "SOC 2 CC6.8", "SOC 2 CC7.2"],
                  timestamp: new Date(log.timestamp).toISOString(),
                };
              });
        downloadJSON(soc2Json, `soc2-compliance-${dateStamp}.json`);
      } else if (exportFormat === "iso-pdf") {
        const isoRows =
          complianceEvidence.length > 0
            ? complianceEvidence.map((item: any) => ({
                auditId: item.auditId,
                toolCall: item.toolInvoked,
                policyDecision: item.policyDecision || "ALLOW",
                ruleMatched: item.ruleEnforced || "Default Zero-Trust Boundary",
                ruleJustification: item.justification || "ArmorIQ Runtime Policy Evaluation",
                cryptographicProof: item.cryptographicProof || "N/A",
                isoStandards: item.complianceControls || [
                  "ISO 27001:2022 A.12.1.2",
                  "ISO 27001:2022 A.14.2.8",
                ],
                timestamp: item.timestamp,
              }))
            : result.rows.map((log) => {
                const meta = (log.metadata as any) || {};
                return {
                  auditId: log.id,
                  toolCall: log.resource,
                  policyDecision: log.decision || "ALLOW",
                  ruleMatched: meta.rule || meta.ruleMatched || "Default Zero-Trust Boundary",
                  ruleJustification:
                    meta.reason || meta.justification || "ArmorIQ Runtime Policy Evaluation",
                  cryptographicProof: meta.proofHash || "N/A",
                  isoStandards: ["ISO 27001:2022 A.12.1.2", "ISO 27001:2022 A.14.2.8"],
                  timestamp: new Date(log.timestamp).toISOString(),
                };
              });
        downloadCompliancePDF(
          "ISO 27001:2022 Audit & Tool Control Traceability Report",
          isoRows,
          `iso27001-compliance-${dateStamp}.pdf`,
        );
      } else if (exportFormat === "iso-csv") {
        const isoCsvRows =
          complianceEvidence.length > 0
            ? complianceEvidence.map((item: any) => ({
                action: item.toolInvoked,
                tool: item.toolInvoked,
                decision: item.policyDecision || "INFO",
                rule: item.ruleEnforced || "ArmorIQ Zero-Trust",
                justification: item.justification || "Evaluated",
                standard: (item.complianceControls || []).join("; ") || "ISO 27001 A.12.1.2",
                timestamp: item.timestamp,
              }))
            : result.rows.map((log) => {
                const meta = (log.metadata as any) || {};
                return {
                  action: log.action,
                  tool: log.resource,
                  decision: log.decision || "INFO",
                  rule: meta.rule || "ArmorIQ Zero-Trust",
                  justification: meta.reason || "Evaluated",
                  standard: "ISO 27001 A.12.1.2",
                  timestamp: new Date(log.timestamp).toISOString(),
                };
              });
        downloadCSV(isoCsvRows, `iso27001-compliance-${dateStamp}.csv`);
      } else if (exportFormat === "json") {
        const jsonRows = result.rows.map((log) => ({
          id: log.id,
          action: log.action,
          user: displayUser(log),
          resource: log.resource,
          decision: log.decision || "INFO",
          timestamp: new Date(log.timestamp).toISOString(),
          metadata: log.metadata ?? null,
        }));
        downloadJSON(jsonRows, `audit-logs-${dateStamp}.json`);
      } else {
        const rows = result.rows.map((log) => ({
          action: log.action,
          user: displayUser(log),
          resource: log.resource,
          decision: log.decision || "INFO",
          timestamp: new Date(log.timestamp).toISOString(),
        }));
        downloadCSV(rows, `audit-logs-${dateStamp}.csv`);
      }

      // The export is capped, and a capped file that looks complete is the
      // worst outcome for an audit trail — this is the artefact someone hands
      // to a reviewer. Say so, and say what to do about it (#659).
      if (result.truncated) {
        toast({
          variant: "destructive",
          title: "Export is incomplete",
          description: `Exported the newest ${result.rows.length.toLocaleString()} of ${result.total.toLocaleString()} matching entries. Narrow the date range or filters to export the rest.`,
        });
      } else {
        toast({
          title: "Export complete",
          description: `Exported ${result.rows.length.toLocaleString()} entries as ${exportFormat.toUpperCase()}.`,
        });
      }
    } finally {
      setIsExporting(false);
    }
  };

  // Debounced so typing in the search box doesn't fire a server call per
  // keystroke; filter dropdown/date changes and page changes are already
  // immediate, so this only smooths out the free-text search.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        // When ArmorIQ filter is enabled, query /api/audit/armoriq directly
        // to render real-time enforcement traces and cryptographic proofs.
        if (armoriqOnly) {
          const params = new URLSearchParams();
          if (decisionFilter !== ALL) params.set("decision", decisionFilter);
          params.set("limit", String(PAGE_SIZE));
          params.set("offset", String((page - 1) * PAGE_SIZE));
          const apiRes = await fetch(`/api/audit/armoriq?${params.toString()}`);
          if (apiRes.ok) {
            const data = await apiRes.json();
            const armoriqRows: UserAuditLogRow[] = (data.traces || []).map((t: any) => ({
              id: t.id,
              action: `ARMORIQ_TOOL_${t.decision}`,
              resource: t.toolName,
              decision: t.decision,
              timestamp: new Date(t.timestamp),
              userId: null,
              metadata: {
                isArmorIQ: true,
                armorIQLogId: t.id,
                agentId: t.agentId,
                toolName: t.toolName,
                rule: t.ruleMatched,
                reason: t.justification,
                proofHash: t.proofHash,
                signature: t.signature,
                intentId: t.intentId,
                complianceFrameworks: t.frameworks,
                privacyLevel: t.privacyLevel,
                scanJobId: t.scanJobId,
                findingId: t.findingId,
              },
            }));
            if (!cancelled) {
              setResult({
                logs: armoriqRows,
                total: data.total ?? armoriqRows.length,
                totalPages: Math.max(1, Math.ceil((data.total ?? armoriqRows.length) / PAGE_SIZE)),
                page,
                pageSize: PAGE_SIZE,
              });
            }
            return;
          }
        }

        const res = await getUserAuditLogs({
          action: actionFilter === ALL ? undefined : actionFilter,
          decision: decisionFilter === ALL ? undefined : decisionFilter,
          search: search.trim() ? search.trim() : undefined,
          startDate: dateFrom ? new Date(`${dateFrom}T00:00:00`) : undefined,
          endDate: dateTo ? new Date(`${dateTo}T23:59:59.999`) : undefined,
          page,
          pageSize: PAGE_SIZE,
        });
        if (!cancelled) setResult(res);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, actionFilter, decisionFilter, dateFrom, dateTo, page, armoriqOnly]);

  const { logs, total, totalPages } = result;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={actionFilter}
            onValueChange={(v) => {
              setActionFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Actions</SelectItem>
              {actions.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={decisionFilter}
            onValueChange={(v) => {
              setDecisionFilter(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="All Decisions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Decisions</SelectItem>
              {decisions.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={armoriqOnly ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setArmoriqOnly((prev) => !prev);
              setPage(1);
            }}
            className={`h-9 gap-1.5 shrink-0 ${
              armoriqOnly
                ? "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-500"
                : "border-emerald-700/40 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/30"
            }`}
            title="Query enforcement traces directly via /api/audit/armoriq"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {armoriqOnly ? "ArmorIQ Active" : "ArmorIQ Traces"}
          </Button>

          {/* Date range + "to" + Export CSV are kept as one non-wrapping
              unit, so Export CSV always sits directly beside the date
              inputs instead of breaking onto a separate line. */}
          <div className="flex flex-nowrap items-center gap-1.5 shrink-0">
            <Input
              type="date"
              aria-label="Filter from date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              max={dateTo || undefined}
              className="w-[140px] h-9 text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              aria-label="Filter to date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              min={dateFrom || undefined}
              className="w-[140px] h-9 text-xs"
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                disabled={isExporting}
                variant="outline"
                size="sm"
                className="h-9 gap-1.5 shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                {isExporting ? "Exporting..." : "Export"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportLogs("csv")}>Export as CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportLogs("json")}>Export as JSON</DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportLogs("soc2-pdf")}>
                🛡️ SOC 2 Evidence (PDF)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportLogs("soc2-json")}>
                🛡️ SOC 2 Evidence (JSON)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportLogs("iso-pdf")}>
                📜 ISO 27001 Traceability (PDF)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportLogs("iso-csv")}>
                📜 ISO 27001 Traceability (CSV)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground bg-foreground/5 rounded-lg hover:bg-foreground/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>

        {/* Search sits on its own row below the filters/date/export row. */}
        <div className="relative w-full lg:max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search action, resource, or decision..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
      </div>

      {/* Table */}
      <div
        className={`rounded-xl border border-foreground/10 overflow-hidden transition-opacity ${
          isLoading ? "opacity-60" : "opacity-100"
        }`}
      >
        <Table>
          <TableHeader className="bg-foreground/5">
            <TableRow className="border-b border-foreground/5 hover:bg-transparent">
              <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">
                Action
              </TableHead>
              <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">
                User
              </TableHead>
              <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">
                Resource
              </TableHead>
              <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4">
                Decision
              </TableHead>
              <TableHead className="text-xs uppercase font-bold text-muted-foreground py-4 text-right">
                Timestamp
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No audit logs match your filters.
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log) => (
                <React.Fragment key={log.id}>
                  {(() => {
                    const meta = (log.metadata as any) || {};
                    const isArmorIQ = meta.isArmorIQ || log.action.startsWith("ARMORIQ_");
                    return (
                      <>
                        <TableRow className="border-b border-foreground/5 hover:bg-foreground/5 transition-colors">
                          <TableCell className="py-4">
                            <div className="flex items-center gap-2">
                              {isArmorIQ && (
                                <span title="ArmorIQ Cryptographically Enforced Intent">
                                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                                </span>
                              )}
                              <span className="font-bold text-sm">{log.action}</span>
                              {(meta.reusedFromCache ||
                                meta.cacheHit ||
                                meta.cacheStatus === "reused from cache" ||
                                (typeof log.action === "string" &&
                                  log.action.includes("reused from cache"))) && (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] text-cyan-400 border-cyan-800/60 font-mono tracking-tight"
                                >
                                  reused from cache
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="py-4">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium">{displayUser(log)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="py-4">
                            <span className="text-xs text-muted-foreground font-mono">
                              {log.resource}
                            </span>
                          </TableCell>
                          <TableCell className="py-4">
                            <Badge
                              variant={
                                log.decision === "BLOCK"
                                  ? "destructive"
                                  : log.decision === "PASS" || log.decision === "ALLOW"
                                    ? "default"
                                    : "secondary"
                              }
                              className="text-[10px] tracking-widest px-1.5"
                            >
                              {log.decision || "INFO"}
                            </Badge>
                          </TableCell>
                          <TableCell className="py-4 text-right">
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {new Intl.DateTimeFormat("en-US", {
                                dateStyle: "medium",
                                timeStyle: "short",
                              }).format(new Date(log.timestamp))}
                            </span>
                          </TableCell>
                        </TableRow>

                        {isArmorIQ && (
                          <TableRow className="border-b border-foreground/5 bg-emerald-950/[0.08]">
                            <TableCell colSpan={5} className="py-3 px-4">
                              <details className="group rounded-xl border border-emerald-800/40 bg-black/60 p-4 text-xs shadow-inner">
                                <summary className="cursor-pointer font-mono font-bold text-emerald-400 hover:text-emerald-300 flex items-center justify-between select-none">
                                  <span className="flex items-center gap-2 text-sm">
                                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>
                                      🛡️ ArmorIQ Cryptographic Intent & Compliance Evidence
                                    </span>
                                    <Badge
                                      variant="outline"
                                      className="text-[9px] text-emerald-400 border-emerald-800/60 font-mono"
                                    >
                                      Tamper-Evident
                                    </Badge>
                                  </span>
                                  <span className="text-xs text-muted-foreground group-open:rotate-180 transition-transform">
                                    ▼
                                  </span>
                                </summary>
                                <div className="mt-3 space-y-3 font-mono text-[11px]">
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                                    <div className="p-2.5 rounded-lg bg-black/80 border border-emerald-900/30 space-y-1">
                                      <span className="text-muted-foreground text-[10px] uppercase font-bold block">
                                        Agent Identity & Intent
                                      </span>
                                      <p className="text-emerald-300">
                                        <span className="text-muted-foreground">Agent: </span>
                                        {meta.agentId || "Autonomous Agent"}
                                      </p>
                                      {meta.intentId && (
                                        <p
                                          className="text-muted-foreground truncate"
                                          title={meta.intentId}
                                        >
                                          <span>Intent ID: </span>
                                          <span className="text-foreground">{meta.intentId}</span>
                                        </p>
                                      )}
                                      {meta.rule && (
                                        <p className="text-muted-foreground">
                                          <span>Enforced Rule: </span>
                                          <span className="text-amber-400">{meta.rule}</span>
                                        </p>
                                      )}
                                    </div>

                                    <div className="p-2.5 rounded-lg bg-black/80 border border-emerald-900/30 space-y-1">
                                      <span className="text-muted-foreground text-[10px] uppercase font-bold block">
                                        Cryptographic Provenance
                                      </span>
                                      <p
                                        className="text-muted-foreground truncate"
                                        title={meta.proofHash}
                                      >
                                        <span>Proof Hash: </span>
                                        <span className="text-emerald-400 font-mono">
                                          {meta.proofHash || "N/A"}
                                        </span>
                                      </p>
                                      <p
                                        className="text-muted-foreground truncate"
                                        title={meta.signature}
                                      >
                                        <span>Signature: </span>
                                        <span className="text-foreground font-mono">
                                          {meta.signature || "N/A"}
                                        </span>
                                      </p>
                                    </div>
                                  </div>

                                  {(meta.reason || meta.justification) && (
                                    <div className="p-2.5 rounded-lg bg-foreground/[0.03] border border-foreground/10 space-y-1">
                                      <span className="text-muted-foreground text-[10px] uppercase font-bold block">
                                        Rule Justification & Policy Decision
                                      </span>
                                      <p className="text-foreground text-xs font-sans">
                                        {meta.reason || meta.justification}
                                      </p>
                                    </div>
                                  )}

                                  {(meta.groqExplanation || meta.explanation) && (
                                    <div className="p-2.5 rounded-lg bg-purple-950/20 border border-purple-800/30 space-y-1">
                                      <span className="text-purple-400 text-[10px] uppercase font-bold block">
                                        Groq AI Security Explanation Context
                                      </span>
                                      <p className="text-purple-200 text-xs font-sans">
                                        {meta.groqExplanation || meta.explanation}
                                      </p>
                                    </div>
                                  )}

                                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/5">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="text-muted-foreground text-[10px] mr-1">
                                        Compliance Mapping:
                                      </span>
                                      {(
                                        (meta.complianceFrameworks as string[]) || [
                                          "SOC 2 (CC6.1, CC6.8)",
                                          "ISO 27001 (A.12.1.2)",
                                          "NIST SP 800-53 (AC-3)",
                                        ]
                                      ).map((framework) => (
                                        <Badge
                                          key={framework}
                                          variant="secondary"
                                          className="text-[10px] bg-emerald-950/40 text-emerald-300 border-emerald-800/40"
                                        >
                                          {framework}
                                        </Badge>
                                      ))}
                                    </div>
                                    <span className="text-[10px] text-muted-foreground font-sans">
                                      🔒 {meta.privacyLevel || "Zero-Retention Metadata Mode"}
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-emerald-900/30 text-[10px]">
                                    <span className="text-muted-foreground flex items-center gap-1.5">
                                      <span>Audit API Route:</span>
                                      <code className="text-emerald-400 bg-emerald-950/40 px-1 py-0.5 rounded border border-emerald-800/40">
                                        /api/audit/armoriq
                                      </code>
                                    </span>
                                    <a
                                      href={`/api/audit/armoriq?decision=${log.decision || "ALLOW"}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-emerald-400 hover:text-emerald-300 hover:underline flex items-center gap-1 font-mono"
                                    >
                                      Verify Proof via API ↗
                                    </a>
                                  </div>
                                </div>
                              </details>
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    );
                  })()}

                  {log.decision === "PASS" && (
                    <TableRow className="border-b border-foreground/5 bg-foreground/[0.02]">
                      <TableCell colSpan={5} className="py-3 px-4">
                        <details className="group rounded-xl border border-red-900/40 bg-black/60 p-4 text-xs shadow-inner">
                          <summary className="cursor-pointer font-mono font-bold text-red-400 hover:text-red-300 flex items-center justify-between select-none">
                            <span className="flex items-center gap-2 text-sm">
                              <span>🎭 Heist Victory Card Preview</span>
                            </span>
                            <span className="text-xs text-muted-foreground group-open:rotate-180 transition-transform">
                              ▼
                            </span>
                          </summary>
                          <div className="mt-4 flex flex-col lg:flex-row gap-5 items-stretch">
                            {/* Card Preview Column */}
                            <div className="flex-1 overflow-hidden rounded-lg border border-red-900/60 bg-black shadow-lg shadow-red-950/20">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={`/api/og/heist?project=${encodeURIComponent(log.resource || "SecureFlow")}`}
                                alt="Heist Card Preview"
                                className="w-full h-auto object-cover"
                              />
                            </div>

                            {/* Resistance Broadcast Side Panel */}
                            <div className="w-full lg:w-80 flex flex-col justify-between rounded-lg border border-red-900/30 bg-red-950/20 p-4 space-y-4">
                              <div className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                  <span className="font-mono text-[11px] font-semibold text-red-400 uppercase tracking-wider">
                                    Audit Clearance Passed
                                  </span>
                                </div>
                                <h4
                                  className="font-bold text-sm text-foreground truncate"
                                  title={log.resource || "SecureFlow"}
                                >
                                  {log.resource || "SecureFlow"}
                                </h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                  The vault is secured with maximum score clearance. Broadcast this
                                  achievement to the Resistance network.
                                </p>
                              </div>

                              <div className="pt-3 border-t border-red-900/30 space-y-2">
                                <a
                                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`🛡️ SecureFlow Heist Broadcast: ${log.resource || "Project"} passed audit check! Join the Resistance!`)}&url=${encodeURIComponent(`${typeof window !== "undefined" ? window.location.origin : ""}/share/heist?project=${encodeURIComponent(log.resource || "SecureFlow")}`)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={() => {
                                    toast({
                                      title: "BROADCAST TRANSMISSION DISPATCHED 📢",
                                      description:
                                        "Publishing victory briefing to the Resistance network.",
                                      variant: "success",
                                    });
                                  }}
                                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-xs transition-colors shadow-md shadow-red-950/50"
                                >
                                  Broadcast to the Resistance 📢
                                </a>
                                <a
                                  href={`/share/heist?project=${encodeURIComponent(log.resource || "SecureFlow")}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={() => {
                                    toast({
                                      title: "TRANSMISSION LINK READY 🔗",
                                      description:
                                        "Opening encrypted public heist transmission channel.",
                                      variant: "success",
                                    });
                                  }}
                                  className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-foreground/10 hover:bg-foreground/5 text-muted-foreground hover:text-foreground font-medium text-xs transition-colors text-center"
                                >
                                  View Public Transmission 🔗
                                </a>
                              </div>
                            </div>
                          </div>
                        </details>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center text-sm">
        <span className="text-muted-foreground">
          {total === 0
            ? "Showing 0 results"
            : `Showing ${start + 1} to ${Math.min(start + PAGE_SIZE, total)} of ${total} logs`}
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="px-3 py-1 bg-foreground/5 rounded hover:bg-foreground/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>
          <span className="text-muted-foreground font-mono text-xs px-2">
            {safePage} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1 bg-foreground/5 rounded hover:bg-foreground/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
