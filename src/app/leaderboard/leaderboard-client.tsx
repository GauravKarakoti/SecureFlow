"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Star } from "lucide-react";

// One contributor's standing on the public leaderboard. Points are stars,
// awarded 1-per-merged-PR (see `score`).
export type ContributorRow = {
  id: string;
  login: string;
  htmlUrl: string;
  avatarUrl: string;
  score: number; // stars — 1 per merged PR
  rank: number; // dense rank (ties share a value)
  prCount: number; // total PRs opened
  mergedCount: number; // merged PRs (== score)
};

// Count-up animation for the hero (#1) star total.
function useCountUp(target: number, active: boolean) {
  const [value, setValue] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const dur = 1000;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setValue(Math.round(target * eased));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, active]);
  return value;
}

function Avatar({ src, alt, size }: { src: string; alt: string; size: number }) {
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      className="shrink-0 rounded-full object-cover ring-1 ring-border"
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
      href={entry.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-card/60 p-5 backdrop-blur-sm transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 sm:p-6 ${
        isHero ? "border-primary/50 shadow-[0_24px_60px_-30px] shadow-primary/40 sm:p-7" : "border-border/60"
      }`}
    >
      {isHero && (
        <span className="mb-3 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.28em] text-amber-500 dark:text-amber-300">
          ★ #1 Most Wanted
        </span>
      )}
      <span className="absolute right-4 top-4 font-headline text-sm font-bold tracking-widest text-muted-foreground/50">
        #{entry.rank}
      </span>

      <div className="mb-3 flex items-center gap-3">
        <Avatar src={entry.avatarUrl} alt={entry.login} size={isHero ? 52 : 40} />
        <span className="text-xl">{medalFor(entry.rank)}</span>
      </div>

      <div
        className={`truncate font-headline font-bold uppercase tracking-wide text-foreground ${
          isHero ? "text-2xl sm:text-3xl" : "text-lg"
        }`}
      >
        {entry.login}
      </div>
      <div className="truncate font-mono text-xs text-muted-foreground">@{entry.login}</div>

      <div
        className={`mt-4 flex items-center gap-1.5 font-headline font-black tabular-nums text-foreground ${
          isHero ? "text-5xl" : "text-3xl"
        }`}
      >
        <Star className={`fill-amber-400 text-amber-400 ${isHero ? "h-8 w-8" : "h-6 w-6"}`} />
        {shown}
        <span className="ml-1 font-mono text-[11px] font-normal uppercase tracking-widest text-muted-foreground">
          stars
        </span>
      </div>

      <div className="mt-4 flex gap-5 border-t border-border/50 pt-3">
        <div className="text-[11px] text-muted-foreground">
          PRs
          <strong className="mt-0.5 block font-headline text-base font-semibold text-foreground">{entry.prCount}</strong>
        </div>
        <div className="text-[11px] text-muted-foreground">
          Merged
          <strong className="mt-0.5 block font-headline text-base font-semibold text-foreground">
            {entry.mergedCount}
          </strong>
        </div>
      </div>
    </a>
  );
}

export default function LeaderboardClient({ contributors }: { contributors: ContributorRow[] }) {
  const entries = contributors;
  const podium = entries.slice(0, 3);
  const isEmpty = entries.length === 0;
  const maxScore = entries[0]?.score || 1;

  return (
    <div className="relative mx-auto w-full max-w-5xl animate-in fade-in overflow-x-hidden pb-16 duration-700">
      {/* ── header ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-primary">
            <span className="h-px w-6 bg-primary" /> La Casa · Season Standings
          </div>
          <h1 className="font-headline text-3xl font-black uppercase leading-none tracking-tight text-foreground sm:text-5xl">
            Most Wanted
            <span className="block text-primary">Leaderboard</span>
          </h1>
        </div>
        {/* Legend: how points are earned (replaces the old search bar). */}
        <div className="inline-flex items-center gap-2 self-start rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-2.5">
          <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-400" />
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-amber-600 dark:text-amber-300">
            1 Star = 1 PR Merged
          </span>
        </div>
      </div>

      <p className="mt-4 max-w-[52ch] text-sm text-muted-foreground">
        The crew is ranked by contribution — every pull request that gets merged earns the author one star.
      </p>

      {isEmpty ? (
        <div className="mt-16 flex min-h-[30vh] items-center justify-center px-4 text-center">
          <p className="text-sm text-muted-foreground">
            No contributors yet. Merge a pull request to claim your first star.
          </p>
        </div>
      ) : (
        <>
          {/* ── podium (top 3) ── */}
          <div className="mt-8 grid grid-cols-1 items-end gap-4 sm:grid-cols-3">
            {podium[1] && (
              <div className="order-2 sm:order-1">
                <PodiumCard entry={podium[1]} isHero={false} />
              </div>
            )}
            {podium[0] && (
              <div className="order-1 sm:order-2">
                <PodiumCard entry={podium[0]} isHero />
              </div>
            )}
            {podium[2] && (
              <div className="order-3">
                <PodiumCard entry={podium[2]} isHero={false} />
              </div>
            )}
          </div>

          {/* ── ranked table ── */}
          <div className="mt-8 overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h2 className="font-headline text-sm font-semibold uppercase tracking-[0.14em] text-foreground">
                The Crew
              </h2>
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {entries.length} operatives
              </span>
            </div>

            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left">
                  <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">#</th>
                  <th className="px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                    Contributor
                  </th>
                  <th className="hidden px-5 py-3 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70 sm:table-cell">
                    PRs
                  </th>
                  <th className="px-5 py-3 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                    Stars
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-border/60 transition-colors hover:bg-accent/10">
                    <td
                      className={`px-5 py-3 font-headline text-lg font-semibold tabular-nums ${
                        e.rank <= 3 ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {String(e.rank).padStart(2, "0")}
                    </td>
                    <td className="px-5 py-3">
                      <a
                        href={e.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 hover:underline"
                      >
                        <Avatar src={e.avatarUrl} alt={e.login} size={30} />
                        <span className="min-w-0">
                          <span className="block truncate font-headline text-sm font-semibold uppercase tracking-wide text-foreground">
                            {e.login}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">@{e.login}</span>
                        </span>
                      </a>
                      <div className="mt-2 hidden h-[3px] max-w-[240px] overflow-hidden rounded bg-border sm:block">
                        <div
                          className="h-full origin-left rounded bg-gradient-to-r from-primary/70 to-primary"
                          style={{ transform: `scaleX(${(e.score / maxScore).toFixed(3)})` }}
                        />
                      </div>
                    </td>
                    <td className="hidden px-5 py-3 text-right tabular-nums text-foreground sm:table-cell">
                      {e.prCount}
                    </td>
                    <td className="px-5 py-3 text-right font-headline text-lg font-black tabular-nums text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                        {e.score}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/50">
            {entries.length} contributors ranked · 1 star per merged PR
          </div>
        </>
      )}
    </div>
  );
}
