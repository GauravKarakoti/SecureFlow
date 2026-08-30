"use client";

import React, { useCallback, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Activity, Database, Server, Brain, RefreshCw, Clock, Zap } from "lucide-react";
import type { ComponentHealth, ComponentStatus } from "@/lib/health-check";

interface StatusClientProps {
  status: ComponentStatus;
  timestamp: string;
  uptime: number;
  components: ComponentHealth[];
}

const STATUS_STYLES: Record<ComponentStatus, { badge: string; dot: string }> = {
  healthy: { badge: "bg-green-500/10 border-green-500/30 text-green-400", dot: "bg-green-400" },
  degraded: { badge: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400", dot: "bg-yellow-400" },
  down: { badge: "bg-red-500/10 border-red-500/30 text-red-400", dot: "bg-red-400" },
};

const COMPONENT_ICONS: Record<string, React.ReactNode> = {
  PostgreSQL: <Database className="w-4 h-4" />,
  Redis: <Server className="w-4 h-4" />,
  "Groq LLM": <Brain className="w-4 h-4" />,
};

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ComponentRow({ component }: { component: ComponentHealth }) {
  const style = STATUS_STYLES[component.status];
  return (
    <div className="flex items-center justify-between rounded-xl border border-foreground/10 bg-foreground/[0.03] p-5 transition-all duration-300 hover:border-primary/30">
      <div className="flex items-center gap-4">
        <div className="rounded-xl bg-primary/10 p-3">
          {COMPONENT_ICONS[component.name] ?? <Activity className="w-4 h-4" />}
        </div>
        <div>
          <p className="text-sm font-bold">{component.name}</p>
          {component.message && (
            <p className="text-[11px] text-muted-foreground mt-0.5">{component.message}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-xs font-mono text-muted-foreground">{component.latencyMs}ms</span>
        <Badge className={`${style.badge} text-xs`}>{component.status}</Badge>
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
      </div>
    </div>
  );
}

export default function StatusClient({ status, timestamp, uptime, components }: StatusClientProps) {
  const [data, setData] = useState({ status, timestamp, uptime, components });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const report = await res.json();
      setData(report);
    } catch {
      // Leave existing data on failure
    } finally {
      setRefreshing(false);
    }
  }, []);

  const style = STATUS_STYLES[data.status];

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <span className="text-sm font-medium uppercase tracking-widest text-primary">System</span>
          <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">Health Status</h1>
          <p className="mt-2 max-w-xl text-muted-foreground">Live infrastructure health for all connected services.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={refreshing}
          className="border-white/10 hover:border-primary/40 bg-white/5 cursor-pointer font-mono text-xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-2 ${refreshing ? "animate-spin text-primary" : ""}`} />
          {refreshing ? "Checking..." : "Refresh"}
        </Button>
      </div>

      {/* Overall Status Banner */}
      <Card className={`glass-card overflow-hidden border ${style.dot.replace("bg-", "border-").replace("-400", "-500/30")}`}>
        <CardContent className="p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className={`w-4 h-4 rounded-full ${style.dot} animate-pulse`} />
            <div>
              <p className="text-xl font-headline font-extrabold uppercase">{data.status}</p>
              <p className="text-xs text-muted-foreground mt-0.5">All systems {data.status === "healthy" ? "operational" : data.status === "degraded" ? "partially operational" : "experiencing issues"}</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="w-3.5 h-3.5" />
              <span>Uptime: <span className="text-white font-bold">{formatUptime(data.uptime)}</span></span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="w-3.5 h-3.5" />
              <span>Checked: <span className="text-white font-bold">{new Date(data.timestamp).toLocaleTimeString()}</span></span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Components */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-bold">
            <Activity className="w-5 h-5 text-primary" /> Components
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {data.components.map((c) => (
              <ComponentRow key={c.name} component={c} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
