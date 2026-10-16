"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AiHealthReport, ModelHealthStatus, FailoverEvent } from "@/ai/telemetry";

interface AiHealthClientProps {
  initialData: AiHealthReport;
  isAdmin: boolean;
}

export default function AiHealthClient({ initialData, isAdmin }: AiHealthClientProps) {
  const [data, setData] = useState<AiHealthReport>(initialData);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(5000); // 5s default
  const [selectedModelForChart, setSelectedModelForChart] = useState<string>("all");
  const [filterFailovers, setFilterFailovers] = useState<string>("");
  const [actionMessage, setActionMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Auto-clear notification messages
  useEffect(() => {
    if (actionMessage) {
      const timer = setTimeout(() => setActionMessage(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [actionMessage]);

  // Fetch telemetry updates from API
  const refreshTelemetry = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const res = await fetch("/api/admin/ai-health", {
        method: "GET",
        headers: { "Cache-Control": "no-cache" },
      });
      if (res.ok) {
        const updated = (await res.json()) as AiHealthReport;
        setData(updated);
      }
    } catch (err) {
      console.error("Failed to refresh AI telemetry:", err);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // Polling hook
  useEffect(() => {
    if (autoRefreshInterval <= 0) return;
    const interval = setInterval(refreshTelemetry, autoRefreshInterval);
    return () => clearInterval(interval);
  }, [autoRefreshInterval, refreshTelemetry]);

  // Admin action handler (Trip / Reset / Clear)
  const handleAdminAction = async (action: "trip" | "reset" | "clear", modelName?: string) => {
    const loadingKey = `${action}-${modelName || "all"}`;
    try {
      setActionLoading(loadingKey);
      const res = await fetch("/api/admin/ai-health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, modelName }),
      });

      const resData = await res.json();
      if (!res.ok) {
        throw new Error(resData.message || resData.error || "Action failed");
      }

      setActionMessage({
        text: resData.message || `Successfully executed ${action} for ${modelName || "metrics"}`,
        type: "success",
      });

      await refreshTelemetry();
    } catch (err: any) {
      setActionMessage({
        text: err.message || "Failed to execute circuit breaker action",
        type: "error",
      });
    } finally {
      setActionLoading(null);
    }
  };

  // Primary model info
  const primaryModel = useMemo(() => {
    return data.models.find((m) => m.isPrimary) || data.models[0];
  }, [data.models]);

  const isPrimaryTripped = data.primaryTripped || (primaryModel && primaryModel.circuitState === "OPEN");

  // Models filtered for chart visualization
  const chartModels = useMemo(() => {
    if (selectedModelForChart === "all") return data.models;
    return data.models.filter((m) => m.modelName === selectedModelForChart);
  }, [data.models, selectedModelForChart]);

  // Filtered failovers
  const filteredFailoverList = useMemo(() => {
    if (!filterFailovers.trim()) return data.recentFailovers;
    const query = filterFailovers.toLowerCase();
    return data.recentFailovers.filter(
      (f) =>
        f.fromModel.toLowerCase().includes(query) ||
        f.toModel.toLowerCase().includes(query) ||
        f.error.toLowerCase().includes(query),
    );
  }, [data.recentFailovers, filterFailovers]);

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto pb-12">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/40 pb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="font-mono text-[10px] tracking-wider uppercase border-primary/40 text-primary bg-primary/5">
              Resilience Telemetry Engine
            </Badge>
            {autoRefreshInterval > 0 && (
              <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                Live ({autoRefreshInterval / 1000}s)
              </span>
            )}
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Cpu className="w-7 h-7 text-primary" />
            AI Model & Circuit Breaker Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time circuit breaker shields, sliding-window latency graphs, and failover switch auditing across AI models.
          </p>
        </div>

        {/* Global Action Bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-card/60 backdrop-blur-md border border-border/60 rounded-lg p-1 text-xs">
            <span className="text-muted-foreground px-2 font-mono">Stream:</span>
            {[
              { label: "Off", value: 0 },
              { label: "3s", value: 3000 },
              { label: "5s", value: 5000 },
              { label: "10s", value: 10000 },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setAutoRefreshInterval(opt.value)}
                className={`px-2 py-1 rounded font-medium transition-all ${
                  autoRefreshInterval === opt.value
                    ? "bg-primary text-primary-foreground font-bold shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={refreshTelemetry}
            disabled={isRefreshing}
            className="flex items-center gap-1.5 font-mono text-xs border-border/80 hover:border-primary/50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin text-primary" : ""}`} />
            Refresh
          </Button>

          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAdminAction("clear")}
              disabled={actionLoading === "clear-all"}
              className="flex items-center gap-1.5 font-mono text-xs text-red-400 border-red-500/20 hover:bg-red-500/10 hover:border-red-500/40"
              title="Clear accumulated metrics and failover history"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Metrics
            </Button>
          )}
        </div>
      </div>

      {/* Action Notification Toast */}
      {actionMessage && (
        <div
          className={`p-3 rounded-lg border text-sm flex items-center justify-between transition-all animate-in fade-in-50 duration-200 ${
            actionMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-red-500/10 border-red-500/30 text-red-300"
          }`}
        >
          <div className="flex items-center gap-2">
            {actionMessage.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            )}
            <span>{actionMessage.text}</span>
          </div>
          <button
            onClick={() => setActionMessage(null)}
            className="text-xs opacity-70 hover:opacity-100 uppercase font-mono ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── CRITICAL ALERT BANNER: Primary Groq Breaker Tripped ───────────────── */}
      {isPrimaryTripped && (
        <div className="relative overflow-hidden rounded-xl border border-red-500/50 bg-gradient-to-r from-red-950/40 via-red-900/20 to-background p-5 shadow-lg shadow-red-950/30">
          <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/10 rounded-full blur-2xl pointer-events-none" />
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 relative z-10">
            <div className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-red-500/20 border border-red-500/40 text-red-400 shrink-0 animate-pulse">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-red-400 uppercase tracking-widest px-2 py-0.5 bg-red-500/20 rounded border border-red-500/30">
                    FAILOVER ACTIVATED
                  </span>
                  <span className="text-xs text-muted-foreground font-mono">
                    Tripped At: {new Date(data.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-white mt-1">
                  Primary Model Circuit Breaker OPEN ({primaryModel?.displayName || primaryModel?.modelName})
                </h3>
                <p className="text-sm text-zinc-300 mt-1 max-w-2xl">
                  Primary model has tripped its failure threshold ({primaryModel?.failureThreshold || 3} consecutive errors/timeouts).
                  Traffic is automatically failing fast to secondary and tertiary fallback models in the resilience chain.
                </p>
              </div>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2 shrink-0 w-full md:w-auto">
                <Button
                  onClick={() => handleAdminAction("reset", primaryModel?.modelName)}
                  disabled={actionLoading === `reset-${primaryModel?.modelName}`}
                  className="bg-red-600 hover:bg-red-500 text-white font-semibold font-mono text-xs shadow-md shadow-red-900/40 w-full md:w-auto"
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                  Reset Primary Breaker
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── System Overview Stats Cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-border/60 bg-card/40 backdrop-blur-sm relative overflow-hidden">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs uppercase font-mono text-muted-foreground flex items-center justify-between">
              Resilience State
              <Zap className="w-3.5 h-3.5 text-primary" />
            </CardDescription>
            <CardTitle className="text-xl font-bold font-headline flex items-center gap-2 mt-1">
              {isPrimaryTripped ? (
                <span className="text-red-400 flex items-center gap-1.5">
                  <XCircle className="w-5 h-5 text-red-400" />
                  Degraded / Failover
                </span>
              ) : (
                <span className="text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  Operational
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xs text-muted-foreground font-mono">
              Primary: {primaryModel?.displayName || "Groq GPT-OSS"}
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/40 backdrop-blur-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs uppercase font-mono text-muted-foreground flex items-center justify-between">
              Total Invocations
              <Activity className="w-3.5 h-3.5 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground mt-1">
              {data.totalRequests.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xs text-muted-foreground">
              Across {data.models.length} registered AI models
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/40 backdrop-blur-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs uppercase font-mono text-muted-foreground flex items-center justify-between">
              System Error Rate
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono mt-1">
              <span className={data.overallErrorRate > 15 ? "text-red-400" : data.overallErrorRate > 5 ? "text-yellow-400" : "text-emerald-400"}>
                {data.overallErrorRate}%
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xs text-muted-foreground">
              {data.totalErrors} errors out of {data.totalRequests} attempts
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/40 backdrop-blur-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs uppercase font-mono text-muted-foreground flex items-center justify-between">
              Failover Switches
              <Shuffle className="w-3.5 h-3.5 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold font-mono text-foreground mt-1">
              {data.totalFailovers}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <p className="text-xs text-muted-foreground">
              {data.recentFailovers.length} recent transitions in memory
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Real-Time Model Readiness Status Matrix ─────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <Server className="w-5 h-5 text-primary" />
              Model Circuit Breaker Status Matrix
            </h2>
            <p className="text-xs text-muted-foreground">
              Live circuit state, failure counters, and latency statistics for all AI models.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.models.map((model) => {
            const isModelOpen = model.circuitState === "OPEN";
            const isModelHalfOpen = model.circuitState === "HALF_OPEN";
            const isModelClosed = model.circuitState === "CLOSED";

            return (
              <Card
                key={model.modelName}
                className={`border transition-all duration-200 relative overflow-hidden ${
                  isModelOpen
                    ? "border-red-500/50 bg-red-950/10 shadow-md shadow-red-950/20"
                    : isModelHalfOpen
                      ? "border-yellow-500/40 bg-yellow-950/10"
                      : "border-border/60 bg-card/50 hover:border-border"
                }`}
              >
                {/* Status Indicator Bar */}
                <div
                  className={`h-1 w-full ${
                    isModelOpen
                      ? "bg-red-500"
                      : isModelHalfOpen
                        ? "bg-yellow-400 animate-pulse"
                        : "bg-emerald-500"
                  }`}
                />

                <CardHeader className="p-4 pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {model.isPrimary && (
                          <Badge className="bg-primary/20 text-primary border-primary/30 text-[10px] font-mono px-1.5 py-0">
                            PRIMARY
                          </Badge>
                        )}
                        {model.isLocal && (
                          <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30 text-[10px] font-mono px-1.5 py-0">
                            LOCAL OLLAMA
                          </Badge>
                        )}
                        <span className="text-[10px] font-mono text-muted-foreground truncate">
                          {model.modelName}
                        </span>
                      </div>
                      <CardTitle className="text-base font-bold mt-1 text-foreground truncate">
                        {model.displayName}
                      </CardTitle>
                    </div>

                    {/* Circuit State Badge */}
                    <div className="shrink-0">
                      {isModelClosed && (
                        <Badge className="bg-emerald-500/10 border-emerald-500/30 text-emerald-400 text-xs font-mono flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          CLOSED
                        </Badge>
                      )}
                      {isModelOpen && (
                        <Badge className="bg-red-500/20 border-red-500/40 text-red-400 text-xs font-mono flex items-center gap-1 animate-pulse">
                          <span className="w-2 h-2 rounded-full bg-red-400" />
                          OPEN (TRIPPED)
                        </Badge>
                      )}
                      {isModelHalfOpen && (
                        <Badge className="bg-yellow-500/10 border-yellow-500/30 text-yellow-400 text-xs font-mono flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-yellow-400" />
                          HALF-OPEN
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="p-4 pt-2 space-y-3">
                  {/* Metric Highlights Grid */}
                  <div className="grid grid-cols-3 gap-2 bg-background/50 rounded-lg p-2.5 border border-border/40 text-center font-mono">
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase block">Avg Latency</span>
                      <span className="text-xs font-bold text-foreground">
                        {model.avgLatencyMs > 0 ? `${model.avgLatencyMs}ms` : "—"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase block">Error Rate</span>
                      <span
                        className={`text-xs font-bold ${
                          model.errorRate > 20
                            ? "text-red-400"
                            : model.errorRate > 0
                              ? "text-yellow-400"
                              : "text-emerald-400"
                        }`}
                      >
                        {model.errorRate}%
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase block">Failures</span>
                      <span className="text-xs font-bold text-foreground">
                        {model.failureCount}/{model.failureThreshold}
                      </span>
                    </div>
                  </div>

                  {/* Operational Details */}
                  <div className="text-xs space-y-1 text-muted-foreground font-mono">
                    <div className="flex justify-between">
                      <span>Requests / Success:</span>
                      <span className="text-foreground">
                        {model.totalRequests} / {model.totalSuccesses}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>P95 Latency:</span>
                      <span className="text-foreground">{model.p95LatencyMs > 0 ? `${model.p95LatencyMs}ms` : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Reset Timeout:</span>
                      <span className="text-foreground">{model.resetTimeoutMs / 1000}s</span>
                    </div>
                  </div>

                  {/* Admin Manual Controls */}
                  {isAdmin && (
                    <div className="pt-2 border-t border-border/40 flex items-center gap-2">
                      {isModelOpen ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAdminAction("reset", model.modelName)}
                          disabled={actionLoading === `reset-${model.modelName}`}
                          className="w-full text-xs font-mono text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10 hover:border-emerald-500/50"
                        >
                          <RotateCcw className="w-3 h-3 mr-1" />
                          Reset Breaker
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleAdminAction("trip", model.modelName)}
                          disabled={actionLoading === `trip-${model.modelName}`}
                          className="w-full text-xs font-mono text-red-400 border-red-500/30 hover:bg-red-500/10 hover:border-red-500/50"
                        >
                          <Power className="w-3 h-3 mr-1" />
                          Trip Breaker
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Sliding-Window Latency Graphs ────────────────────────────────────── */}
      <Card className="border-border/60 bg-card/50 backdrop-blur-sm">
        <CardHeader className="p-4 sm:p-6 pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                Sliding-Window Latency Visualizer
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Execution response time (ms) history over recent AI requests per model.
              </CardDescription>
            </div>

            {/* Model Filter Selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-mono">Filter:</span>
              <select
                value={selectedModelForChart}
                onChange={(e) => setSelectedModelForChart(e.target.value)}
                className="bg-background/80 border border-border/80 rounded-md px-2.5 py-1 text-xs font-mono text-foreground focus:outline-none focus:border-primary"
              >
                <option value="all">All Models Combined</option>
                {data.models.map((m) => (
                  <option key={m.modelName} value={m.modelName}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-4 sm:p-6 pt-2">
          <LatencyVisualizer models={chartModels} />
        </CardContent>
      </Card>

      {/* ── Failover Event History & Audit ───────────────────────────────────── */}
      <Card className="border-border/60 bg-card/50 backdrop-blur-sm">
        <CardHeader className="p-4 sm:p-6 pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <Shuffle className="w-5 h-5 text-primary" />
                Failover Switch & Transition History
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-0.5">
                Chronological log of dynamic fallback switches, rate-limit trips, and recovery routing.
              </CardDescription>
            </div>

            <div className="w-full sm:w-64">
              <input
                type="text"
                placeholder="Search failovers..."
                value={filterFailovers}
                onChange={(e) => setFilterFailovers(e.target.value)}
                className="w-full bg-background/80 border border-border/80 rounded-md px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary font-mono"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-4 sm:p-6 pt-2">
          {filteredFailoverList.length === 0 ? (
            <div className="py-12 text-center rounded-lg border border-dashed border-border/60 bg-background/20">
              <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto mb-2 opacity-60" />
              <p className="text-sm font-medium text-foreground">No Failover Events Recorded</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                AI workflows are operating normally on their primary models without requiring dynamic fallback switches.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground uppercase text-[10px]">
                    <th className="py-2.5 px-3">Timestamp</th>
                    <th className="py-2.5 px-3">Route Transition</th>
                    <th className="py-2.5 px-3">Type</th>
                    <th className="py-2.5 px-3">Attempt</th>
                    <th className="py-2.5 px-3">Trigger Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {filteredFailoverList.map((event) => (
                    <tr key={event.id} className="hover:bg-foreground/[0.02] transition-colors">
                      <td className="py-3 px-3 whitespace-nowrap text-muted-foreground">
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 font-bold">
                          <span className="text-red-400">{event.fromModel}</span>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <span className="text-emerald-400">{event.toModel}</span>
                        </div>
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap">
                        {event.fastFail ? (
                          <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px] font-mono px-1.5 py-0">
                            FAST-FAIL (OPEN)
                          </Badge>
                        ) : (
                          <Badge className="bg-yellow-500/10 text-yellow-400 border-yellow-500/20 text-[10px] font-mono px-1.5 py-0">
                            RETRY-EXHAUSTED
                          </Badge>
                        )}
                      </td>
                      <td className="py-3 px-3 whitespace-nowrap text-muted-foreground">
                        {event.attempt > 0 ? `Attempt ${event.attempt}` : "Immediate (0)"}
                      </td>
                      <td className="py-3 px-3 text-muted-foreground max-w-md truncate">
                        <span title={event.error}>{event.error}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── SVG Sliding Window Latency Visualizer Component ───────────────────────────
function LatencyVisualizer({ models }: { models: ModelHealthStatus[] }) {
  // Extract all samples from provided models
  const samplesWithModel = useMemo(() => {
    const list: Array<{ model: string; color: string; durationMs: number; timestamp: number; success: boolean }> = [];
    const colors = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];

    models.forEach((model, mIdx) => {
      const color = colors[mIdx % colors.length];
      model.recentLatencies.forEach((s) => {
        list.push({
          model: model.displayName,
          color,
          durationMs: s.durationMs,
          timestamp: s.timestamp,
          success: s.success,
        });
      });
    });

    return list.sort((a, b) => a.timestamp - b.timestamp);
  }, [models]);

  if (samplesWithModel.length === 0) {
    return (
      <div className="h-48 flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-background/20 text-center">
        <Activity className="w-8 h-8 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground font-mono">
          No latency samples recorded yet. Execute AI requests to view real-time duration curves.
        </p>
      </div>
    );
  }

  const width = 800;
  const height = 180;
  const padding = { top: 20, right: 30, bottom: 30, left: 50 };

  const maxDuration = Math.max(...samplesWithModel.map((s) => s.durationMs), 500);
  const minDuration = 0;

  const points = samplesWithModel.map((s, idx) => {
    const x = padding.left + (idx / Math.max(1, samplesWithModel.length - 1)) * (width - padding.left - padding.right);
    const y =
      height -
      padding.bottom -
      ((s.durationMs - minDuration) / (maxDuration - minDuration || 1)) *
        (height - padding.top - padding.bottom);
    return { ...s, x, y };
  });

  const polylinePoints = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex items-center gap-4 flex-wrap text-xs font-mono">
        {models.map((m, idx) => {
          const colors = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4"];
          const color = colors[idx % colors.length];
          return (
            <div key={m.modelName} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-muted-foreground">{m.displayName}</span>
              <span className="text-foreground font-bold">({m.avgLatencyMs}ms avg)</span>
            </div>
          );
        })}
      </div>

      {/* SVG Canvas */}
      <div className="w-full overflow-x-auto no-scrollbar">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-48 bg-background/40 rounded-lg border border-border/40"
        >
          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = height - padding.bottom - ratio * (height - padding.top - padding.bottom);
            const val = Math.round(minDuration + ratio * (maxDuration - minDuration));
            return (
              <g key={ratio}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="currentColor"
                  className="text-border/30"
                  strokeDasharray="3 3"
                />
                <text
                  x={padding.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="text-[10px] fill-muted-foreground font-mono"
                >
                  {val}ms
                </text>
              </g>
            );
          })}

          {/* Area fill gradient */}
          <defs>
            <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Connected Polyline */}
          <polyline
            fill="none"
            stroke="#10b981"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={polylinePoints}
          />

          {/* Data Points */}
          {points.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={p.y}
              r={p.success ? "3.5" : "5"}
              fill={p.success ? p.color : "#ef4444"}
              stroke={p.success ? "#ffffff" : "#fee2e2"}
              strokeWidth="1"
              className="cursor-pointer transition-transform hover:scale-150"
            >
              <title>{`${p.model}: ${p.durationMs}ms (${p.success ? "Success" : "Failed"})`}</title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  );
}
