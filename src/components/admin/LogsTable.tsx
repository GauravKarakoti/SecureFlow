"use client";

import React, { useEffect, useState } from "react";

import {
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronR,
  History,
  X,
} from "lucide-react";
import { getAuditLogs } from "@/lib/actions/admin";
import type { AuditLogRow } from "@/lib/actions/admin";

const ITEMS_PER_PAGE = 15;

function actionBadgeClass(action: string): string {
  const a = action.toUpperCase();
  if (a.startsWith("ADMIN_")) return "bg-red-500/10 text-red-400 border-red-500/30";
  if (a.includes("SCAN") || a.includes("FINDING"))
    return "bg-purple-500/10 text-purple-300 border-purple-500/30";
  if (a.includes("POLICY")) return "bg-amber-500/10 text-amber-400 border-amber-500/30";
  if (a.includes("LOGIN") || a.includes("AUTH"))
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
  return "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
}

export default function LogsTable({ logs, actions }: { logs: AuditLogRow[]; actions: string[] }) {
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [serverResult, setServerResult] = useState<{
    logs: AuditLogRow[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>({
    logs,
    total: logs.length,
    page: 1,
    pageSize: logs.length,
    totalPages: 1,
  });

  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      setIsLoading(true);
      try {
        const res = await getAuditLogs({
          action: actionFilter === "ALL" ? undefined : actionFilter,
          search: search.trim() ? search.trim() : undefined,
          page,
          pageSize: ITEMS_PER_PAGE,
        });

        if (!cancelled) {
          setServerResult(res);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [actionFilter, page, search]);

  const safePage = Math.min(page, serverResult.totalPages);
  const start = (safePage - 1) * ITEMS_PER_PAGE;
  const current = serverResult.logs;
  const totalPages = serverResult.totalPages;

  const hasFilters = search.trim() !== "" || actionFilter !== "ALL";
  const clearFilters = () => {
    setSearch("");
    setActionFilter("ALL");
    setPage(1);
  };

  const totalResults = serverResult.total;

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      {/* Toolbar */}
      <div className="p-4 border-b border-zinc-800 flex flex-col lg:flex-row gap-3 lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Search action, resource, decision, or actor..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="bg-black border border-zinc-700 text-white text-sm rounded-lg pl-9 pr-4 py-2 w-full focus:outline-none focus:ring-2 focus:ring-red-500"
          />
        </div>
        <div className="flex items-center gap-2">
          <select
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
            className="bg-black border border-zinc-700 text-white text-sm rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="ALL">All Actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-xs text-zinc-400 hover:text-white bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors"
            >
              <X className="w-3.5 h-3.5" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-zinc-400 min-w-[900px]">
          <thead className="bg-zinc-950 text-zinc-500 text-xs uppercase border-b border-zinc-800">
            <tr>
              <th className="px-6 py-4 w-8"></th>
              <th className="px-6 py-4">Action</th>
              <th className="px-6 py-4">Actor</th>
              <th className="px-6 py-4">Resource</th>
              <th className="px-6 py-4">Decision</th>
              <th className="px-6 py-4">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {current.length > 0 ? (
              current.map((l) => {
                const isOpen = expanded === l.id;
                const hasMeta = l.metadata != null;
                return (
                  <React.Fragment key={l.id}>
                    <tr
                      onClick={() => hasMeta && setExpanded(isOpen ? null : l.id)}
                      className={`border-b border-zinc-800/50 transition-colors ${
                        hasMeta ? "cursor-pointer hover:bg-zinc-800/50" : "hover:bg-zinc-800/30"
                      }`}
                    >
                      <td className="px-6 py-4">
                        {hasMeta ? (
                          isOpen ? (
                            <ChevronDown className="w-4 h-4 text-zinc-500" />
                          ) : (
                            <ChevronR className="w-4 h-4 text-zinc-500" />
                          )
                        ) : null}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider font-mono border ${actionBadgeClass(
                            l.action,
                          )}`}
                        >
                          {l.action}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {l.actor ? (
                          <div className="flex flex-col">
                            <span className="text-zinc-200">{l.actor.name || l.actor.email}</span>
                            <span className="text-zinc-600 text-[10px] font-mono uppercase tracking-wider">
                              {l.actor.codename || "—"}
                            </span>
                          </div>
                        ) : (
                          <span className="text-zinc-600 italic text-xs">System</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-xs text-zinc-300 break-all">
                        {l.resource}
                      </td>
                      <td className="px-6 py-4">
                        {l.decision ? (
                          <span className="text-zinc-300 font-mono text-xs">{l.decision}</span>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-zinc-500 font-mono text-xs whitespace-nowrap" suppressHydrationWarning>
                        {new Date(l.timestamp).toLocaleString()}
                      </td>
                    </tr>
                    {isOpen && hasMeta && (
                      <tr className="bg-black/40">
                        <td colSpan={6} className="px-6 py-4">
                          <div className="rounded-lg border border-zinc-800 bg-black p-4">
                            <p className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2 font-bold">
                              Metadata
                            </p>
                            <pre className="text-xs text-emerald-300/90 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                              {(() => {
                                try {
                                  return JSON.stringify(l.metadata, null, 2);
                                } catch {
                                  return String(l.metadata);
                                }
                              })()}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-zinc-500">
                  <History className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No audit logs match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="p-4 border-t border-zinc-800 flex flex-col sm:flex-row gap-2 sm:justify-between sm:items-center text-sm">
        <span className="text-zinc-500">
          {totalResults === 0
            ? "Showing 0 results"
            : `Showing ${start + 1} to ${Math.min(
                start + ITEMS_PER_PAGE,
                totalResults,
              )} of ${totalResults} logs`}
        </span>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" /> Previous
          </button>
          <span className="text-zinc-500 font-mono text-xs px-2">
            {safePage} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
