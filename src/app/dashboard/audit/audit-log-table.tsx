"use client";

import React, { useEffect, useState } from "react";
import { Search, X, ChevronLeft, ChevronRight, History } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getUserAuditLogs,
  type UserAuditLogResult,
  type UserAuditLogRow,
} from "@/lib/actions/audit";

const PAGE_SIZE = 10;
const ALL = "ALL";

export default function AuditLogTable({
  initialResult,
  actions,
  decisions,
  displayUser,
}: {
  initialResult: UserAuditLogResult;
  actions: string[];
  decisions: string[];
  displayUser: (log: UserAuditLogRow) => string;
}) {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState(ALL);
  const [decisionFilter, setDecisionFilter] = useState(ALL);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<UserAuditLogResult>(initialResult);
  const [isLoading, setIsLoading] = useState(false);

  const hasFilters =
    search.trim() !== "" || actionFilter !== ALL || decisionFilter !== ALL;

  const clearFilters = () => {
    setSearch("");
    setActionFilter(ALL);
    setDecisionFilter(ALL);
    setPage(1);
  };

  // Debounced so typing in the search box doesn't fire a server call per
  // keystroke; filter dropdown changes and page changes are already
  // immediate, so this only smooths out the free-text search.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const res = await getUserAuditLogs({
          action: actionFilter === ALL ? undefined : actionFilter,
          decision: decisionFilter === ALL ? undefined : decisionFilter,
          search: search.trim() ? search.trim() : undefined,
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
  }, [search, actionFilter, decisionFilter, page]);

  const { logs, total, totalPages } = result;
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * PAGE_SIZE;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
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

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground bg-foreground/5 rounded-lg hover:bg-foreground/10 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
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
                  <TableRow className="border-b border-foreground/5 hover:bg-foreground/5 transition-colors">
                    <TableCell className="py-4">
                      <span className="font-bold text-sm">{log.action}</span>
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
                            : log.decision === "PASS"
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
                  {log.decision === "PASS" && (
                    <TableRow>
                      <TableCell colSpan={5}>
                        <div className="mt-4">
                          <details className="group border border-red-500/20 bg-black rounded-lg p-4 cursor-pointer">
                            <summary className="text-red-500 font-bold outline-none flex items-center justify-between">
                              <span>📥 Reveal Heist Success Card</span>
                              <span className="text-xs text-red-500/70 group-open:hidden">
                                Click to expand
                              </span>
                            </summary>

                            <div className="mt-6 flex flex-col items-center">
                              <img
                                src={`/api/og/heist?project=${encodeURIComponent(
                                  log.resource || "The Royal Mint"
                                )}`}
                                alt="Heist Success Card"
                                className="w-full max-w-2xl rounded-md border border-red-900/50 shadow-2xl mb-6"
                              />
                              <a
                                href={`https://twitter.com/intent/tweet?text=The%20vault%20is%20empty.%20Zero%20traces%20left%20behind.%20%F0%9F%8E%AD%0A%0AAudit%20passed%20via%20SecureFlow.&url=${encodeURIComponent(
                                  `https://secure-flow-six.vercel.app/share/heist?project=${
                                    log.resource || "The Royal Mint"
                                  }`
                                )}`}
                                target="_blank"
                                rel="noreferrer"
                                className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded shadow-lg transition-all"
                              >
                                Broadcast to the Resistance 📢
                              </a>
                            </div>
                          </details>
                        </div>
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