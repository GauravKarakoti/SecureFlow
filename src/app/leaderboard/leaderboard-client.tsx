"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Swords } from "lucide-react";
import { CyberTextReveal } from "@/components/cyber-text-reveal";
import { formatBounty, type Badge, type FormResult, type SeverityCounts } from "./scoring";

const POLL_INTERVAL_MS = 30_000;

function useLiveLeaderboard(initial: ContributorRow[]) {
  const [entries, setEntries] = useState<ContributorRow[]>(initial);
  const [isLive, setIsLive] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    function startSSE() {
      const es = new EventSource("/api/leaderboard?stream=true");
      esRef.current = es;

      es.onopen = () => setIsLive(true);

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.contributors) setEntries(data.contributors);
          if (data.timestamp) setLastUpdated(data.timestamp);
        } catch {
          // ignore malformed frames
        }
      };

      es.onerror = () => {
        setIsLive(false);
        es.close();
        esRef.current = null;
        startPolling();
      };
    }

    function startPolling() {
      if (pollRef.current) return;
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/leaderboard", { cache: "no-store" });
          if (res.ok) {
            const data = await res.json();
            if (data.contributors) setEntries(data.contributors);
            if (data.timestamp) setLastUpdated(data.timestamp);
          }
        } catch {
          // silently ignore — stale data is fine
        }
      }, POLL_INTERVAL_MS);
    }

    if (typeof EventSource !== "undefined") {
      startSSE();
    } else {
      startPolling();
    }

    return () => {
      esRef.current?.close();
      esRef.current = null;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setIsLive(false);
    };
  }, []);

  return { entries, isLive, lastUpdated };
}

export type ContributorRow = {
  id: string;
  login: string;
  codename: string | null;
  htmlUrl: string;
  avatarUrl: string;
  /** Security score (0-100) from `computeContributorScore`, not a PR count. */
  score: number;
  rank: number;
  prCount: number;
  mergedCount: number;
  /** Pull requests that scanned clean (`status = "PASS"`). */
  passedCount: number;
  /** Vulnerabilities the author's most recent scans still attribute to them. */
  findings: SeverityCounts;
  badges: Badge[];
  /** Outcome of the five most recent pull requests, newest first. */
  form: FormResult[];
};

/** Colour treatment for the W / D / L pips. */
const FORM_STYLE: Record<FormResult, { className: string; title: string }> = {
  W: { className: "bg-emerald-500/20 text-emerald-400 ring-emerald-500/40", title: "Passed" },
  D: { className: "bg-yellow-500/20 text-yellow-400 ring-yellow-500/40", title: "Review required" },
  L: { className: "bg-red-500/20 text-red-400 ring-red-500/40", title: "Blocked" },
};

function FormStrip({ form }: { form: FormResult[] }) {
  if (!form || form.length === 0) return null;
  return (
    <div className="flex items-center gap-1" aria-label="Recent pull request outcomes">
      {form.map((result, i) => (
        <span
          key={i}
          title={FORM_STYLE[result].title}
          className={`inline-flex h-4 w-4 items-center justify-center rounded-sm font-mono text-[9px] font-bold ring-1 ${FORM_STYLE[result].className}`}
        >
          {result}
        </span>
      ))}
    </div>
  );
}

function BadgeStrip({ badges }: { badges: Badge[] }) {
  if (!badges || badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.map((badge) => (
        <span
          key={badge.label}
          title={badge.label}
          className="inline-flex items-center gap-1 rounded-full border border-red-900/40 bg-black/40 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"
        >
          <span aria-hidden>{badge.emoji}</span>
          {badge.label}
        </span>
      ))}
    </div>
  );
}

/** Total vulnerabilities across all severities, for the compact summary line. */
function totalFindings(counts: SeverityCounts | undefined): number {
  if (!counts) return 0;
  return counts.critical + counts.high + counts.medium + counts.low;
}

function useCountUp(target: number, active: boolean) {
  const [value, setValue] = useState(() => (active ? 0 : target));
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const start = performance.now();
    const dur = 1000;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setValue(Math.round(target * eased));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target, active]);
  return value;
}

function Avatar({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <Image
      src={src} alt={alt} width={size} height={size} unoptimized
      className="shrink-0 rounded-full object-cover ring-1 ring-red-500/40"
      style={{ width: size, height: size }}
    />
  );
}

function medalFor(rank: number) {
  return rank === 1 ? "👑" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : "";
}

function PodiumCard({ entry, isHero }: { entry: ContributorRow; isHero: boolean }) {
  const shown = useCountUp(entry.score, isHero);
  return (
    <a
      href={entry.htmlUrl} target="_blank" rel="noopener noreferrer"
      className={`group relative flex flex-col overflow-hidden rounded-2xl border p-5 backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 sm:p-6 ${
        isHero
          ? "border-red-500/60 bg-gradient-to-b from-red-950/80 to-black shadow-[0_24px_60px_-30px] shadow-red-700/50 sm:p-7"
          : "border-red-900/30 bg-black/60 hover:border-red-500/40"
      }`}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-60" />
      {isHero && (
        <span className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-red-400">
          <Swords className="h-3.5 w-3.5" /> #1 Most Wanted
        </span>
      )}
      <span className="absolute right-4 top-4 font-mono text-sm font-bold tracking-widest text-red-500/50">
        #{entry.rank}
      </span>
      <div className="mb-3 flex items-center gap-3">
        <Avatar src={entry.avatarUrl} alt={entry.login} size={isHero ? 52 : 40} />
        <span className="text-xl">{medalFor(entry.rank)}</span>
      </div>
      <div className={`truncate font-bold uppercase tracking-wide text-foreground ${isHero ? "text-2xl sm:text-3xl" : "text-lg"}`}>
        {entry.codename}
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground">
        <CyberTextReveal codename={entry.codename ?? entry.login} realName={`@${entry.login}`} duration={300} />
      </div>
      <div className={`mt-4 flex items-center gap-1.5 font-black tabular-nums text-foreground ${isHero ? "text-5xl" : "text-3xl"}`}>
        {formatBounty(shown)}
        <span className="ml-1 font-mono text-[11px] font-normal uppercase tracking-widest text-red-400/70">bounty</span>
      </div>
      <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Security score {entry.score}/100
      </div>
      <div className="mt-3">
        <FormStrip form={entry.form} />
      </div>
      <div className="mt-4 flex gap-5 border-t border-red-900/30 pt-3">
        <div className="text-[11px] text-muted-foreground">
          Heists<strong className="mt-0.5 block text-base font-semibold text-foreground">{entry.prCount}</strong>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Extractions<strong className="mt-0.5 block text-base font-semibold text-foreground">{entry.mergedCount}</strong>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Clean<strong className="mt-0.5 block text-base font-semibold text-foreground">{entry.passedCount}</strong>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Breaches
          <strong
            className={`mt-0.5 block text-base font-semibold ${
              totalFindings(entry.findings) > 0 ? "text-red-400" : "text-emerald-400"
            }`}
          >
            {totalFindings(entry.findings)}
          </strong>
        </div>
      </div>
      <div className="mt-3">
        <BadgeStrip badges={entry.badges} />
      </div>
    </a>
  );
}

export default function LeaderboardClient({ contributors }: { contributors: ContributorRow[] }) {
  const { entries, isLive, lastUpdated } = useLiveLeaderboard(contributors);
  const formattedTime = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  const podium = entries.slice(0, 3);
  const isEmpty = entries.length === 0;
  const maxScore = entries[0]?.score || 1;

  return (
    <div className="relative mx-auto w-full max-w-5xl animate-in fade-in overflow-x-hidden pb-16 duration-700">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-red-400">
            <span className="h-px w-6 bg-red-500" /> La Casa de Papel · Resistance Roster
          </div>
          <h1 className="text-3xl font-black uppercase leading-none tracking-tight text-foreground sm:text-5xl">
            Most Wanted<span className="block text-red-500">Leaderboard</span>
          </h1>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2.5">
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-red-400">€10K per security point</span>
          </div>
          <div className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
            <span className={`h-2 w-2 rounded-full ${isLive ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-emerald-600 dark:text-emerald-400">
              {isLive ? "Live Updates" : "Polling"}
            </span>
          </div>
          {formattedTime && (
            <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 font-mono text-xs text-muted-foreground">
              <span>Last Updated:</span>
              <span className="font-semibold text-foreground">{formattedTime}</span>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 max-w-[58ch] text-sm text-muted-foreground">
        The Resistance is ranked by security score — clean, merged work earns bounty, and every
        vulnerability an operative ships takes it back. Volume alone will not move you up the board.
        Hover a codename to reveal their true identity.
      </p>

      {isEmpty ? (
        <div className="mt-16 flex min-h-[30vh] items-center justify-center px-4 text-center">
          <p className="text-sm text-muted-foreground">No operatives yet. Merge a clean pull request to claim your first bounty.</p>
        </div>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-1 items-end gap-4 sm:grid-cols-3">
            {podium[1] && <div className="order-2 sm:order-1"><PodiumCard entry={podium[1]} isHero={false} /></div>}
            {podium[0] && <div className="order-1 sm:order-2"><PodiumCard entry={podium[0]} isHero /></div>}
            {podium[2] && <div className="order-3"><PodiumCard entry={podium[2]} isHero={false} /></div>}
          </div>

          <div className="mt-8 overflow-hidden rounded-2xl border border-red-900/30 bg-black/40">
            <div className="flex items-center justify-between border-b border-red-900/30 px-5 py-4">
              <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-foreground">The Crew</h2>
              <span className="font-mono text-[11px] uppercase tracking-widest text-red-400/60">{entries.length} operatives</span>
            </div>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left">
                  <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-red-400/50">#</th>
                  <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-red-400/50">Operative</th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[10px] uppercase tracking-widest text-red-400/50 sm:table-cell">Heists</th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[10px] uppercase tracking-widest text-red-400/50 sm:table-cell">Breaches</th>
                  <th className="hidden px-5 py-3 text-center font-mono text-[10px] uppercase tracking-widest text-red-400/50 md:table-cell">Form</th>
                  <th className="px-5 py-3 text-right font-mono text-[10px] uppercase tracking-widest text-red-400/50">Bounty</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-red-900/20 transition-colors hover:bg-red-950/20">
                    <td className={`px-5 py-3 font-mono text-lg font-semibold tabular-nums ${e.rank <= 3 ? "text-red-400" : "text-muted-foreground"}`}>
                      {String(e.rank).padStart(2, "0")}
                    </td>
                    <td className="px-5 py-3">
                      <a href={e.htmlUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 hover:underline">
                        <Avatar src={e.avatarUrl} alt={e.login} size={30} />
                        <span className="min-w-0">
                          <span className="block truncate font-mono text-sm font-semibold uppercase tracking-wide text-foreground">{e.codename}</span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            <CyberTextReveal codename={e.codename ?? e.login} realName={`@${e.login}`} duration={200} />
                          </span>
                        </span>
                      </a>
                      <div className="mt-2 hidden h-[3px] max-w-[240px] overflow-hidden rounded bg-red-900/30 sm:block">
                        <div className="h-full origin-left rounded bg-gradient-to-r from-red-700 to-red-500" style={{ transform: `scaleX(${(e.score / maxScore).toFixed(3)})` }} />
                      </div>
                    </td>
                    <td className="hidden px-5 py-3 text-right tabular-nums text-foreground sm:table-cell">{e.prCount}</td>
                    <td
                      className={`hidden px-5 py-3 text-right tabular-nums sm:table-cell ${
                        totalFindings(e.findings) > 0 ? "text-red-400" : "text-emerald-400"
                      }`}
                    >
                      {totalFindings(e.findings)}
                    </td>
                    <td className="hidden px-5 py-3 md:table-cell">
                      <div className="flex justify-center">
                        <FormStrip form={e.form} />
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-lg font-black tabular-nums text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {formatBounty(e.score)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-red-400/40">
            {entries.length} operatives ranked · €10K per extraction
          </div>
        </>
      )}
    </div>
  );
}
