"use client";

import { CyberTextReveal } from "@/components/cyber-text-reveal";
import { CyberRainBackground } from "./cyber-rain-background";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { FALLBACK_HEIST_MESSAGE } from "@/ai/flows/heist-message-stream";

/**
 * HeistTransmission
 * -----------------
 * Client component that turns the /share/heist page into an encrypted
 * terminal transmission from The Professor.
 *
 * AI Streaming (Feature #311)
 * ---------------------------
 * On mount the component opens an EventSource to /api/heist-transmission to
 * stream a unique, Groq-generated cryptic message per share link. Incoming
 * `chunk` events accumulate the text; a `done` event closes the source and
 * replaces the last narrative placeholder line with the AI's complete message.
 *
 * If Groq is unavailable (no API key, network error, etc.) the component falls
 * back to the original static lines — zero regression.
 *
 * Existing behaviour
 * ------------------
 * Each line of the message is rendered through `<CyberTextReveal
 * variant="transmission" />` in auto-decode mode: the line mounts as `█`
 * blocks, scrambles through noise, and resolves left-to-right into the
 * decrypted payload.
 *
 * Lines decode **sequentially** — line N+1 does not begin until line N's
 * `onRevealComplete` fires — so the whole thing reads like a secure channel
 * dripping text one line at a time.  Once the final line resolves, the OG
 * heist card and the "Join the Resistance" CTA fade in as the "decrypted
 * payload".
 *
 * Accessibility / UX guards
 * -------------------------
 * • `prefers-reduced-motion` short-circuits the sequence and shows the fully
 *   decrypted transmission + payload immediately.
 * • A `>> skip decryption` affordance lets impatient accomplices jump to the
 *   end.
 * • Screen readers always hear the decrypted `aria-label`, never the noise.
 */

type LineKind = "system" | "narrative" | "data" | "blank";

interface TransmissionLine {
  kind: LineKind;
  text: string;
  /** Whether to scramble-decode (`true`) or fade in instantly (`false`). */
  decode: boolean;
}

interface HeistTransmissionProps {
  projectName: string;
  score?: number;
  rank?: string;
  findingsCount?: number;
  tagline: string;
  /** Relative URL of the OG heist card image (revealed post-transmission). */
  imageUrl: string;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Per-kind colour — keeps the terminal readable within the heist palette. */
function lineColor(kind: LineKind): string {
  switch (kind) {
    case "system":
      return "text-red-500/90";
    case "data":
      return "text-zinc-300";
    case "narrative":
      return "text-zinc-100";
    case "blank":
    default:
      return "";
  }
}

// ── Static fallback lines (used when Groq is unavailable) ────────────────────
function buildStaticLines(
  projectName: string,
  score: number | undefined,
  rank: string | undefined,
  findingsCount: number | undefined,
  tagline: string,
): TransmissionLine[] {
  const out: TransmissionLine[] = [
    { kind: "system",    text: "> INITIALIZING SECURE CHANNEL............ [OK]", decode: true },
    { kind: "system",    text: "> DECRYPTING TRANSMISSION................. [OK]", decode: true },
    { kind: "system",    text: "> SENDER: THE PROFESSOR",                          decode: true },
    { kind: "blank",     text: "",                                              decode: false },
    { kind: "narrative", text: "Bella ciao, accomplice.",                        decode: true },
    { kind: "blank",     text: "",                                              decode: false },
    { kind: "narrative", text: `The heist on ${projectName} is complete.`,       decode: true },
    { kind: "data",      text: "Audit status: PASSED",                           decode: true },
  ];
  if (score !== undefined) {
    out.push({ kind: "data", text: `Security score: ${score}/100`, decode: true });
  }
  if (rank) {
    out.push({ kind: "data", text: `Clearance tier: RANK ${rank}`, decode: true });
  }
  if (findingsCount !== undefined) {
    out.push({ kind: "data", text: `Findings logged: ${findingsCount}`, decode: true });
  }
  out.push({ kind: "blank",      text: "",                                       decode: false });
  out.push({ kind: "narrative",  text: `"${tagline}"`,                           decode: true });
  out.push({ kind: "blank",      text: "",                                       decode: false });
  out.push({ kind: "narrative",  text: "The vault is sealed. Zero traces remain.", decode: true });
  out.push({ kind: "blank",      text: "",                                       decode: false });
  out.push({ kind: "system",     text: "> END OF TRANSMISSION.",                 decode: true });
  return out;
}

// ── AI lines builder — replaces the narrative body with the Groq message ─────
function buildAiLines(
  projectName: string,
  score: number | undefined,
  rank: string | undefined,
  findingsCount: number | undefined,
  aiMessage: string,
): TransmissionLine[] {
  const out: TransmissionLine[] = [
    { kind: "system",    text: "> INITIALIZING SECURE CHANNEL............ [OK]", decode: true },
    { kind: "system",    text: "> DECRYPTING TRANSMISSION................. [OK]", decode: true },
    { kind: "system",    text: "> SENDER: THE PROFESSOR",                          decode: true },
    { kind: "blank",     text: "",                                              decode: false },
    { kind: "data",      text: `TARGET: ${projectName}`,                         decode: true },
    { kind: "data",      text: "Audit status: PASSED",                           decode: true },
  ];
  if (score !== undefined) {
    out.push({ kind: "data", text: `Security score: ${score}/100`, decode: true });
  }
  if (rank) {
    out.push({ kind: "data", text: `Clearance tier: RANK ${rank}`, decode: true });
  }
  if (findingsCount !== undefined) {
    out.push({ kind: "data", text: `Findings logged: ${findingsCount}`, decode: true });
  }
  out.push({ kind: "blank",     text: "",            decode: false });

  // Wrap each sentence of the AI message as its own narrative line for sequential decode.
  const sentences = aiMessage
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    out.push({ kind: "narrative", text: sentence, decode: true });
  }

  out.push({ kind: "blank",  text: "",                   decode: false });
  out.push({ kind: "system", text: "> END OF TRANSMISSION.", decode: true });
  return out;
}

export function HeistTransmission({
  projectName,
  score,
  rank,
  findingsCount,
  tagline,
  imageUrl,
}: HeistTransmissionProps) {
  // ── AI stream state ──────────────────────────────────────────────────────────
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(true);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    // Build the SSE URL with query params matching page.tsx logic.
    const params = new URLSearchParams({ project: projectName });
    if (score !== undefined) params.set("score", String(score));
    if (rank)                params.set("rank", rank);
    if (findingsCount !== undefined) params.set("findingsCount", String(findingsCount));

    const es = new EventSource(`/api/heist-transmission?${params.toString()}`);
    esRef.current = es;

    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as
          | { type: "chunk"; text: string }
          | { type: "done"; message: string }
          | { type: "error"; message: string };

        if (event.type === "chunk") {
          // Live preview — show accumulating text as it arrives.
          setAiMessage(event.text);
        } else if (event.type === "done") {
          setAiMessage(event.message);
          setAiLoading(false);
          es.close();
        } else {
          // AI error — fall back to static lines.
          setAiMessage(null);
          setAiLoading(false);
          es.close();
        }
      } catch {
        setAiMessage(null);
        setAiLoading(false);
        es.close();
      }
    };

    es.onerror = () => {
      setAiMessage(null);
      setAiLoading(false);
      es.close();
    };

    return () => {
      es.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Build the Professor's transmission ─────────────────────────────────────
  // Memoised — stable so the sequential decode indices don't reset mid-stream.
  const lines = useMemo<TransmissionLine[]>(() => {
    if (!aiLoading && aiMessage) {
      return buildAiLines(projectName, score, rank, findingsCount, aiMessage);
    }
    return buildStaticLines(projectName, score, rank, findingsCount, tagline);
  }, [projectName, score, rank, findingsCount, tagline, aiMessage, aiLoading]);

  const total = lines.length;

  // ── Respect prefers-reduced-motion ──────────────────────────────────────────
  // Starts `false` so the SSR markup matches the first client render (avoids
  // hydration mismatch); the effect flips it after mount.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReducedMotion(mql.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // ── Sequential decode state ──────────────────────────────────────────────────
  // `revealedCount` = number of lines fully decoded. The line at index
  // `revealedCount` is the "active" one currently decoding.
  const [revealedCount, setRevealedCount] = useState(0);
  const blankTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset sequential decode whenever the line array changes (AI message arrived).
  const prevLinesRef = useRef<TransmissionLine[]>(lines);
  useEffect(() => {
    if (prevLinesRef.current !== lines) {
      prevLinesRef.current = lines;
      setRevealedCount(0);
    }
  }, [lines]);

  const transmissionComplete = revealedCount >= total;

  // Blank / instant lines don't go through the scramble hook, so the parent
  // advances them itself on a short timer to keep the cadence readable.
  useEffect(() => {
    if (reducedMotion || transmissionComplete) return;
    const current = lines[revealedCount];
    if (!current || current.decode) return; // decode lines advance via onRevealComplete

    blankTimerRef.current = setTimeout(() => {
      setRevealedCount((c) => Math.min(c + 1, total));
    }, 220);

    return () => {
      if (blankTimerRef.current !== null) {
        clearTimeout(blankTimerRef.current);
        blankTimerRef.current = null;
      }
    };
  }, [revealedCount, lines, total, reducedMotion, transmissionComplete]);

  // Reduced-motion fast path: reveal the entire transmission + payload at once.
  useEffect(() => {
    if (reducedMotion && !transmissionComplete) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRevealedCount(total);
    }
  }, [reducedMotion, total, transmissionComplete]);

  const skipIntro = () => setRevealedCount(total);

  // How many lines are visible right now. In reduced-motion mode every line
  // is shown as plain text (no active decoder).
  const visibleCount = reducedMotion ? total : Math.min(revealedCount + 1, total);

  return (
    <div className="min-h-screen bg-black flex flex-col relative">
      {/* ── Atmospheric cyber-rain backdrop (fills the empty gutters) ────
          Fixed, full-viewport, very low opacity, pointer-events: none.
          Sits behind everything; the terminal card below lifts to z-10. */}
      <CyberRainBackground opacity={0.13} />

      {/* Vignette so the terminal card stays the visual focal point even
          with rain behind it — darkens edges, keeps center readable. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.75) 100%)",
        }}
      />

      <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 relative z-10">
        <div
          className={cn(
            "w-full max-w-3xl rounded-md border border-red-900/60 shadow-2xl",
            "bg-[#050505] relative overflow-hidden",
            // Soft red glow so the card separates from the rain backdrop.
            "shadow-[0_0_60px_-15px_rgba(239,68,68,0.25)]",
          )}
        >
          {/* ── CRT scanline overlay (purely decorative) ─────────────────── */}
          <div
            className="pointer-events-none absolute inset-0 z-20 opacity-[0.07]"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, #fff 0px, #fff 1px, transparent 1px, transparent 3px)",
            }}
            aria-hidden
          />

          {/* ── Terminal title bar ─────────────────────────────────────── */}
          <div className="relative z-10 flex items-center justify-between px-4 py-2 border-b border-red-900/50 bg-black">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-600/80" />
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            </div>
            <div className="font-mono text-[10px] sm:text-xs tracking-[0.3em] uppercase text-zinc-500">
              SecureFlow // Heist Audit
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[10px] sm:text-xs tracking-widest uppercase text-red-500">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse motion-reduce:animate-none" />
              {aiLoading ? "Receiving" : "Live"}
            </div>
          </div>

          {/* ── Transmission body ──────────────────────────────────────── */}
          <div className="relative z-10 p-5 sm:p-7 font-mono text-sm sm:text-base leading-relaxed min-h-[340px]">
            {lines.slice(0, visibleCount).map((line, i) => {
              const isActive = !reducedMotion && i === revealedCount;
              const isShown = reducedMotion || i < revealedCount;

              // Blank lines are layout spacers — they appear as soon as their
              // index enters the visible window, then the parent advances.
              if (line.kind === "blank") {
                return <div key={i} className="h-4" aria-hidden />;
              }

              // Narrative lines from the AI stream use Orbitron for the
              // cyber-aesthetic called for in Feature #311.
              const fontClass =
                line.kind === "narrative" ? "font-orbitron tracking-wide" : "";

              // Already-decoded lines render as plain text so they never
              // re-scramble on subsequent renders.
              if (isShown) {
                return (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-words",
                      lineColor(line.kind),
                      fontClass,
                    )}
                  >
                    {line.text}
                  </div>
                );
              }

              // Active line: drive the sequential decode through the shared
              // CyberTextReveal component in transmission mode.
              return (
                <div key={i} className="flex items-start gap-2 break-words">
                  <CyberTextReveal
                    as="div"
                    variant="transmission"
                    text={line.text}
                    duration={Math.min(100 + line.text.length * 12, 750)}
                    className={cn(
                      "whitespace-pre-wrap",
                      lineColor(line.kind),
                      fontClass,
                    )}
                    onRevealComplete={() =>
                      setRevealedCount((c) => Math.min(c + 1, total))
                    }
                  />
                  {isActive && (
                    <span
                      className="terminal-blink mt-1 inline-block h-4 w-2 shrink-0 bg-red-500 sm:h-5 motion-reduce:animate-none"
                      aria-hidden
                    />
                  )}
                </div>
              );
            })}

            {/* Idle cursor once the channel goes quiet ─────────────────── */}
            {transmissionComplete && !reducedMotion && (
              <div className="mt-3 flex items-center gap-2 text-red-500/80">
                <span className="terminal-blink motion-reduce:animate-none">_</span>
                <span className="text-xs uppercase tracking-widest">channel idle</span>
              </div>
            )}
          </div>

          {/* ── Decrypted payload: OG card + CTA (revealed post-transmission) ── */}
          <div
            className={cn(
              "relative z-10 border-t border-red-900/50 bg-black p-5 sm:p-7",
              "transition-all duration-700 motion-reduce:transition-none",
              transmissionComplete
                ? "translate-y-0 opacity-100"
                : "pointer-events-none translate-y-4 opacity-0",
            )}
            aria-hidden={!transmissionComplete}
          >
            {/* OG image is generated by an edge route — plain <img> matches the
                existing pattern and avoids next/image remote-config overhead. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="Heist Success Card"
              className="mb-5 w-full rounded border border-red-900/50 shadow-lg"
            />
            <p className="mb-1 text-center text-lg font-bold text-red-500">
              Audit passed via SecureFlow.
            </p>
            <p className="mx-auto mb-5 max-w-md text-center text-sm text-zinc-400">
              {tagline}
            </p>
            <div className="flex justify-center">
              <Link
                href="/"
                className="rounded bg-red-600 px-6 py-3 font-bold text-white shadow-lg transition-all hover:bg-red-700"
              >
                Join the Resistance
              </Link>
            </div>
          </div>
        </div>

        {/* ── Skip affordance ─────────────────────────────────────────── */}
        {!transmissionComplete && !reducedMotion && (
          <button
            type="button"
            onClick={skipIntro}
            className="mt-4 font-mono text-[10px] uppercase tracking-widest text-zinc-600 transition-colors hover:text-zinc-300 sm:text-xs"
          >
            &gt;&gt; skip decryption
          </button>
        )}
      </main>

      <footer className="py-4 text-center relative z-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-zinc-600 sm:text-xs">
          #BellaCiao · #JoinTheResistance
        </p>
      </footer>
    </div>
  );
}
