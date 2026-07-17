"use client";

import React, { useState, useEffect } from "react";
import CountUp from "react-countup";
import { Terminal, ShieldAlert, CheckCircle2, AlertTriangle, Shield, Cpu, RefreshCw } from "lucide-react";

interface TerminalStep {
  text: string;
  type: "command" | "info" | "warning" | "error" | "success" | "ai";
  delay: number;
}

const TERMINAL_STEPS: TerminalStep[] = [
  { text: "⚙️ Initializing SecureFlow static analysis engines...", type: "info", delay: 800 },
  { text: "🔍 Scanning 14 files in commit diff [a9f82d]...", type: "info", delay: 1200 },
  { text: "⚠️ Found potential matching pattern in config/production.json", type: "warning", delay: 800 },
  { text: "❌ CRITICAL LEAK: Stripe Secret API Key exposed on line 24!", type: "error", delay: 1000 },
  { text: "❌ CRITICAL LEAK: Private RSA key detected in deploy.sh", type: "error", delay: 800 },
  { text: "🚫 SECURITY BARRIER DEPLOYED: Pull request #452 blocked from merging.", type: "error", delay: 1200 },
  { text: "🤖 [The Professor] Plan of Action:", type: "ai", delay: 500 },
  { text: "   1. Immediately rotate exposed Stripe credential (sk_live_***).", type: "ai", delay: 600 },
  { text: "   2. Move environment configs to Encrypted Secrets Vault.", type: "ai", delay: 600 },
  { text: "🔄 Awaiting security resolution to clear gates...", type: "info", delay: 2000 },
];

interface InteractiveDemoProps {
  prsCount?: number;
  secretsCount?: number;
  scanAverage?: number;
  reposCount?: number;
}

export default function InteractiveDemo({
  prsCount = 45208,
  secretsCount = 1842,
  scanAverage = 1.4,
  reposCount = 948,
}: InteractiveDemoProps) {
  const [terminalLines, setTerminalLines] = useState<TerminalStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (isResetting) return;

    if (stepIndex < TERMINAL_STEPS.length) {
      const step = TERMINAL_STEPS[stepIndex];
      const timer = setTimeout(() => {
        setTerminalLines((prev) => [...prev, step]);
        setStepIndex((prev) => prev + 1);
      }, step.delay);
      return () => clearTimeout(timer);
    } else {
      // Loop back after showing everything for 6 seconds
      const resetTimer = setTimeout(() => {
        setIsResetting(true);
        setTerminalLines([]);
        setStepIndex(0);
        setTimeout(() => setIsResetting(false), 500);
      }, 6000);
      return () => clearTimeout(resetTimer);
    }
  }, [stepIndex, isResetting]);

  return (
    <div className="space-y-16">
      {/* Animated Counter Section */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 max-w-6xl mx-auto">
        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 text-center hover:border-primary/40 transition-all duration-300">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <p className="text-xs font-mono font-bold tracking-widest text-muted-foreground uppercase mb-2">PRs Protected</p>
          <h4 className="text-4xl font-extrabold text-foreground font-headline tracking-tight">
            <CountUp end={prsCount} duration={3} separator="," enableScrollSpy scrollSpyOnce />
          </h4>
        </div>

        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 text-center hover:border-primary/40 transition-all duration-300">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <p className="text-xs font-mono font-bold tracking-widest text-muted-foreground uppercase mb-2">Secrets Blocked</p>
          <h4 className="text-4xl font-extrabold text-primary font-headline tracking-tight">
            <CountUp end={secretsCount} duration={2.5} separator="," enableScrollSpy scrollSpyOnce />
          </h4>
        </div>

        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 text-center hover:border-primary/40 transition-all duration-300">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <p className="text-xs font-mono font-bold tracking-widest text-muted-foreground uppercase mb-2">Scan Average</p>
          <h4 className="text-4xl font-extrabold text-foreground font-headline tracking-tight">
            <CountUp end={scanAverage} decimals={1} duration={2} suffix="s" enableScrollSpy scrollSpyOnce />
          </h4>
        </div>

        <div className="glass-card group relative overflow-hidden rounded-xl border border-white/10 p-6 text-center hover:border-primary/40 transition-all duration-300">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
          <p className="text-xs font-mono font-bold tracking-widest text-muted-foreground uppercase mb-2">Protected Repos</p>
          <h4 className="text-4xl font-extrabold text-foreground font-headline tracking-tight">
            <CountUp end={reposCount} duration={2} separator="," enableScrollSpy scrollSpyOnce />
          </h4>
        </div>
      </div>


      {/* Terminal Mockup Panel */}
      <div className="relative rounded-xl border border-white/10 overflow-hidden glass-card shadow-2xl max-w-4xl mx-auto">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-black/60 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
            <span className="text-[11px] font-mono text-zinc-500 ml-2 select-none">SF_MISSION_CONTROL_TERMINAL</span>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            <span className="text-[10px] text-primary font-bold uppercase tracking-wider font-mono">Secured</span>
          </div>
        </div>

        {/* Terminal Console Content */}
        <div className="p-6 bg-black/90 min-h-[380px] font-mono text-sm leading-relaxed overflow-y-auto max-h-[480px]">
          <div className="space-y-2">
            {terminalLines.map((line, idx) => (
              <div
                key={idx}
                className={`animate-in fade-in slide-in-from-left-2 duration-300 ${
                  line.type === "command"
                    ? "text-white"
                    : line.type === "info"
                    ? "text-zinc-400"
                    : line.type === "warning"
                    ? "text-yellow-400"
                    : line.type === "error"
                    ? "text-red-500 font-semibold"
                    : line.type === "ai"
                    ? "text-[#ff4b55] font-medium"
                    : "text-emerald-400 font-bold"
                }`}
              >
                {line.type === "command" && <span className="text-primary mr-2 select-none">$</span>}
                {line.text}
              </div>
            ))}

            {/* Blinking Cursor */}
            {!isResetting && (
              <div className="flex items-center gap-1 mt-3">
                <span className="text-primary mr-2 select-none">$</span>
                <span className="w-2.5 h-4 bg-primary animate-pulse" />
              </div>
            )}
            
            {isResetting && (
              <div className="flex items-center gap-2 justify-center py-16 text-zinc-500 text-xs italic">
                <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                Resetting terminal transmission...
              </div>
            )}
          </div>
        </div>

        {/* High-tech overlays */}
        <div className="absolute bottom-6 right-6 p-4 rounded-lg glass-card border-primary/20 bg-black/80 max-w-[280px] hidden md:block animate-pulse duration-[3000ms]">
          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded bg-primary/10 text-primary border border-primary/30 mt-0.5">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[11px] font-bold text-primary font-mono uppercase tracking-wider">Breach Defended</p>
              <p className="text-[10px] text-zinc-400 font-mono mt-1">PR #452 blocked by Professor Vault Security Gate.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
