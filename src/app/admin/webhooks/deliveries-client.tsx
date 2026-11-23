"use client";

import React, { useEffect, useState, useTransition } from "react";
import {
  Webhook,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Clock,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { WebhookDeliveryStats } from "@/lib/webhooks/delivery-recorder";

export interface DeliveryItem {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  repository: string | null;
  outcome: string;
  reasonCode: string;
  error: string | null;
  createdAt: string | Date;
}

interface DeliveriesClientProps {
  initialDeliveries: DeliveryItem[];
  initialTotal: number;
  initialStats: WebhookDeliveryStats;
  initialRepositories: string[];
}

function formatTimeAgo(dateInput: string | Date, nowMs: number) {
  const date = new Date(dateInput);
  const seconds = Math.floor((nowMs - date.getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function DeliveriesClient({
  initialDeliveries,
  initialTotal,
  initialStats,
  initialRepositories,
}: DeliveriesClientProps) {
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>(initialDeliveries);
  const [total, setTotal] = useState(initialTotal);
  const [stats, setStats] = useState(initialStats);
  const [repositories] = useState(initialRepositories);
  const [nowMs, setNowMs] = useState<number>(() => new Date(0).getTime());

  const [selectedOutcome, setSelectedOutcome] = useState<string>("ALL");
  const [selectedRepo, setSelectedRepo] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [page, setPage] = useState(0);
  const pageSize = 25;

  const [isPending, startTransition] = useTransition();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const syncClock = () => setNowMs(Date.now());
    syncClock();
    const timer = window.setInterval(syncClock, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const fetchDeliveries = (
    newPage = 0,
    outcome = selectedOutcome,
    repo = selectedRepo,
    search = searchQuery,
  ) => {
    startTransition(async () => {
      const params = new URLSearchParams();
      if (outcome && outcome !== "ALL") params.set("outcome", outcome);
      if (repo && repo !== "ALL") params.set("repository", repo);
      if (search && search.trim()) params.set("search", search.trim());
      params.set("limit", String(pageSize));
      params.set("offset", String(newPage * pageSize));

      try {
        const res = await fetch(`/api/admin/webhooks?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setDeliveries(data.deliveries || []);
          setTotal(data.total || 0);
          if (data.stats) setStats(data.stats);
          setPage(newPage);
          setNowMs(Date.now());
        }
      } catch (err) {
        console.error("Failed to load webhook deliveries", err);
      }
    });
  };

  const handleOutcomeChange = (outcome: string) => {
    setSelectedOutcome(outcome);
    fetchDeliveries(0, outcome, selectedRepo, searchQuery);
  };

  const handleRepoChange = (repo: string) => {
    setSelectedRepo(repo);
    fetchDeliveries(0, selectedOutcome, repo, searchQuery);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchDeliveries(0, selectedOutcome, selectedRepo, searchQuery);
  };

  const handleReset = () => {
    setSelectedOutcome("ALL");
    setSelectedRepo("ALL");
    setSearchQuery("");
    fetchDeliveries(0, "ALL", "ALL", "");
  };

  const handleCopy = (text: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedId(text);
      setTimeout(() => setCopiedId(null), 2000);
    }
  };

  const getOutcomeBadge = (outcome: string) => {
    switch (outcome.toLowerCase()) {
      case "scanned":
        return (
          <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 uppercase tracking-widest text-[10px] font-mono">
            <CheckCircle className="w-3 h-3 mr-1" />
            Scanned
          </Badge>
        );
      case "queued":
        return (
          <Badge className="bg-blue-500/10 text-blue-400 border border-blue-500/30 uppercase tracking-widest text-[10px] font-mono">
            <Clock className="w-3 h-3 mr-1 animate-pulse" />
            Queued
          </Badge>
        );
      case "ignored":
        return (
          <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/30 uppercase tracking-widest text-[10px] font-mono">
            <AlertTriangle className="w-3 h-3 mr-1" />
            Ignored
          </Badge>
        );
      case "rejected":
        return (
          <Badge className="bg-red-500/10 text-red-400 border border-red-500/30 uppercase tracking-widest text-[10px] font-mono">
            <XCircle className="w-3 h-3 mr-1" />
            Rejected
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="uppercase tracking-widest text-[10px] font-mono">
            {outcome}
          </Badge>
        );
    }
  };

  const getReasonCodeBadge = (reasonCode: string) => {
    const code = reasonCode.toUpperCase();
    let colorClass = "bg-muted text-muted-foreground border-border";

    if (code === "SCANNED") {
      colorClass = "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    } else if (code === "QUEUED") {
      colorClass = "bg-blue-500/15 text-blue-300 border-blue-500/30";
    } else if (code === "DRAFT_PR" || code === "REPO_DISABLED" || code === "AUTHOR_SKIPPED") {
      colorClass = "bg-amber-500/15 text-amber-300 border-amber-500/30";
    } else if (
      code.includes("SIGNATURE") ||
      code.includes("TOO_LARGE") ||
      code.includes("INVALID") ||
      code.includes("FAILED")
    ) {
      colorClass = "bg-red-500/15 text-red-300 border-red-500/30";
    } else if (code === "DUPLICATE") {
      colorClass = "bg-purple-500/15 text-purple-300 border-purple-500/30";
    } else if (code === "PING") {
      colorClass = "bg-cyan-500/15 text-cyan-300 border-cyan-500/30";
    }

    return (
      <Badge
        variant="outline"
        className={`font-mono text-[10px] px-2 py-0.5 tracking-wider uppercase ${colorClass}`}
        data-testid={`reason-code-${code}`}
      >
        {code}
      </Badge>
    );
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-6">
      {/* Metrics Banner */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-5">
        {/* Total Deliveries */}
        <div className="glass-card rounded-xl border border-white/10 p-4 transition-all duration-300">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Total (7d)
            </span>
            <Webhook className="w-4 h-4 text-primary" />
          </div>
          <div className="text-2xl font-black font-headline text-white">{stats.total}</div>
        </div>

        {/* Scanned */}
        <div className="glass-card rounded-xl border border-white/10 p-4 transition-all duration-300">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              Scanned
            </span>
            <CheckCircle className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-black font-headline text-emerald-400">{stats.scanned}</div>
        </div>

        {/* Queued */}
        <div className="glass-card rounded-xl border border-white/10 p-4 transition-all duration-300">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">
              Queued
            </span>
            <Clock className="w-4 h-4 text-blue-400" />
          </div>
          <div className="text-2xl font-black font-headline text-blue-400">{stats.queued}</div>
        </div>

        {/* Ignored */}
        <div className="glass-card rounded-xl border border-white/10 p-4 transition-all duration-300">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
              Ignored
            </span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-black font-headline text-amber-400">{stats.ignored}</div>
        </div>

        {/* Rejected */}
        <div className="glass-card rounded-xl border border-white/10 p-4 transition-all duration-300 col-span-2 lg:col-span-1">
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-red-400">
              Rejected
            </span>
            <XCircle className="w-4 h-4 text-red-400" />
          </div>
          <div className="text-2xl font-black font-headline text-red-400">{stats.rejected}</div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="glass-card p-4 rounded-xl border border-white/10 flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <form onSubmit={handleSearchSubmit} className="flex-1 flex flex-col sm:flex-row gap-3">
          {/* Repository Selector */}
          <div className="min-w-[180px]">
            <Select value={selectedRepo} onValueChange={handleRepoChange}>
              <SelectTrigger className="h-10 min-h-[44px] bg-background/50 border-white/10 text-xs">
                <SelectValue placeholder="All Repositories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Repositories</SelectItem>
                {repositories.map((repo) => (
                  <SelectItem key={repo} value={repo}>
                    {repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Outcome Selector */}
          <div className="min-w-[150px]">
            <Select value={selectedOutcome} onValueChange={handleOutcomeChange}>
              <SelectTrigger
                className="h-10 min-h-[44px] bg-background/50 border-white/10 text-xs"
                data-testid="outcome-filter-trigger"
              >
                <SelectValue placeholder="All Outcomes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Outcomes</SelectItem>
                <SelectItem value="scanned">Scanned</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="ignored">Ignored</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Keyword Search Input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-3 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              placeholder="Search by Delivery ID, Event or Reason Code..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-10 min-h-[44px] bg-background/50 border-white/10 text-xs"
            />
          </div>

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            className="h-10 min-h-[44px] px-4 text-xs font-mono uppercase"
          >
            Filter
          </Button>
        </form>

        <div className="flex items-center gap-2">
          {(selectedOutcome !== "ALL" || selectedRepo !== "ALL" || searchQuery) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="h-10 min-h-[44px] text-xs font-mono uppercase text-muted-foreground hover:text-white"
            >
              Reset
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchDeliveries(page)}
            disabled={isPending}
            className="h-10 min-h-[44px] px-3 text-xs font-mono uppercase border-white/10 gap-1.5"
            data-testid="refresh-deliveries-button"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Deliveries Container: Responsive Desktop Table & Mobile Stacked Cards */}
      <div className="glass-card rounded-xl border border-white/10 overflow-hidden">
        {deliveries.length === 0 ? (
          <div className="p-12 text-center flex flex-col items-center justify-center gap-3">
            <Webhook className="w-10 h-10 text-muted-foreground/40" />
            <div className="text-sm font-medium text-muted-foreground">
              No webhook deliveries recorded for the selected filters.
            </div>
            <p className="text-xs text-muted-foreground/60 max-w-sm">
              Deliveries are retained for the last 7 days and refreshed automatically.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table View (>= 768px) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-white/[0.03] border-b border-white/10 text-[10px] uppercase font-mono tracking-wider text-muted-foreground sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <th className="py-3 px-4">Delivery ID</th>
                    <th className="py-3 px-4">Event • Action</th>
                    <th className="py-3 px-4">Repository</th>
                    <th className="py-3 px-4">Outcome</th>
                    <th className="py-3 px-4">Reason Code</th>
                    <th className="py-3 px-4">Details</th>
                    <th className="py-3 px-4 text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {deliveries.map((delivery) => (
                    <tr
                      key={delivery.id}
                      className="hover:bg-white/[0.02] transition-colors"
                      data-testid={`delivery-row-${delivery.deliveryId}`}
                    >
                      {/* Delivery ID */}
                      <td className="py-3 px-4 font-mono text-[11px]">
                        <div className="flex items-center gap-1.5 group">
                          <span
                            className="text-muted-foreground group-hover:text-white transition-colors"
                            title={delivery.deliveryId}
                          >
                            {delivery.deliveryId.length > 12
                              ? `${delivery.deliveryId.slice(0, 10)}…`
                              : delivery.deliveryId}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopy(delivery.deliveryId)}
                            className="p-1 min-h-[30px] min-w-[30px] flex items-center justify-center opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-white transition-opacity"
                            title="Copy Delivery ID"
                            aria-label={`Copy Delivery ID ${delivery.deliveryId}`}
                          >
                            {copiedId === delivery.deliveryId ? (
                              <Check className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* Event • Action */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 font-medium text-white">
                          <span>{delivery.eventType}</span>
                          {delivery.action && (
                            <span className="text-muted-foreground font-mono text-[10px]">
                              - {delivery.action}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Repository */}
                      <td className="py-3 px-4">
                        {delivery.repository ? (
                          <span
                            className="font-mono text-muted-foreground"
                            title={delivery.repository}
                          >
                            {delivery.repository}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40 italic font-mono text-[10px]">
                            —
                          </span>
                        )}
                      </td>

                      {/* Outcome */}
                      <td className="py-3 px-4">{getOutcomeBadge(delivery.outcome)}</td>

                      {/* Reason Code */}
                      <td className="py-3 px-4">{getReasonCodeBadge(delivery.reasonCode)}</td>

                      {/* Details / Error */}
                      <td className="py-3 px-4 max-w-[280px]">
                        {delivery.error ? (
                          <span
                            className="text-muted-foreground truncate block"
                            title={delivery.error}
                          >
                            {delivery.error}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/30 italic text-[10px]">—</span>
                        )}
                      </td>

                      {/* Time */}
                      <td className="py-3 px-4 text-right font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        <time
                          dateTime={new Date(delivery.createdAt).toISOString()}
                          title={new Date(delivery.createdAt).toLocaleString()}
                        >
                          {formatTimeAgo(delivery.createdAt, nowMs)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Stacked Card View (< 768px) */}
            <div className="md:hidden divide-y divide-white/10">
              {deliveries.map((delivery) => (
                <div
                  key={delivery.id}
                  className="p-4 space-y-3"
                  data-testid={`delivery-card-${delivery.deliveryId}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {getOutcomeBadge(delivery.outcome)}
                      {getReasonCodeBadge(delivery.reasonCode)}
                    </div>
                    <time
                      dateTime={new Date(delivery.createdAt).toISOString()}
                      className="text-[11px] font-mono text-muted-foreground"
                    >
                      {formatTimeAgo(delivery.createdAt, nowMs)}
                    </time>
                  </div>

                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-white">
                        {delivery.eventType}
                        {delivery.action && (
                          <span className="text-xs font-normal text-muted-foreground ml-1.5 font-mono">
                            ({delivery.action})
                          </span>
                        )}
                      </div>
                      {delivery.repository && (
                        <div className="text-xs font-mono text-muted-foreground mt-0.5">
                          {delivery.repository}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground font-mono bg-white/[0.02] p-2 rounded border border-white/5">
                    <span className="truncate" title={delivery.deliveryId}>
                      ID: {delivery.deliveryId}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(delivery.deliveryId)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-white"
                      aria-label={`Copy ID ${delivery.deliveryId}`}
                    >
                      {copiedId === delivery.deliveryId ? (
                        <Check className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>

                  {delivery.error && (
                    <div className="text-xs text-red-300/90 bg-red-500/10 border border-red-500/20 p-2 rounded">
                      {delivery.error}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="p-4 border-t border-white/10 flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono">
                  Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} of {total}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchDeliveries(page - 1)}
                    disabled={page === 0 || isPending}
                    className="h-9 min-h-[44px] px-3 font-mono text-xs border-white/10"
                    aria-label="Previous Page"
                  >
                    <ChevronLeft className="w-3.5 h-3.5 mr-1" />
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fetchDeliveries(page + 1)}
                    disabled={page >= totalPages - 1 || isPending}
                    className="h-9 min-h-[44px] px-3 font-mono text-xs border-white/10"
                    aria-label="Next Page"
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
