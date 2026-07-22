"use client";

import { useEffect, useRef } from "react";

/**
 * CyberRainBackground
 * -------------------
 * A canvas-based "matrix rain" of monospace characters drifting down the
 * full viewport behind the heist share page. Fills the empty side gutters
 * with atmospheric motion without competing with the terminal foreground.
 *
 * Design choices
 * --------------
 * • Canvas (not DOM) — a few hundred glyphs at 60fps with zero layout cost.
 * • Very low global alpha (~0.12) so it reads as texture, not content.
 * • Heist-red palette (#ef4444) with a few dimmer zinc columns for depth.
 * • Leading glyph of each column is brighter — the classic "falling head"
 *   that makes the rain feel alive.
 * • ~8% of columns are "word columns" that spell a heist term vertically
 *   (BELLA CIAO, PROFESSOR, RESISTANCE, …) instead of noise — a nod to the
 *   theme without being distracting.
 * • `prefers-reduced-motion` renders a single static frame and stops the
 *   animation loop entirely (zero CPU when reduced motion is requested).
 * • Pauses when the tab is hidden so it never burns cycles off-screen.
 *
 * The canvas is `position: fixed; inset: 0; z-index: 0; pointer-events: none`
 * so the terminal card (z-10+) always sits cleanly on top and is fully
 * interactive.
 */

const SCRAMBLE_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%!<>/\\|";

/** Heist-themed words that occasionally fall as a vertical column. */
const HEIST_WORDS = [
  "BELLA CIAO",
  "PROFESSOR",
  "RESISTANCE",
  "VAULT",
  "SECUREFLOW",
  "HEIST",
  "DECRYPT",
  "GHOST PROTOCOL",
  "OBSERVE",
  "ACCOMPLICE",
  "CLEARED",
  "ZERO TRACES",
];

interface Column {
  x: number;          // pixel x of the column's left edge
  y: number;          // pixel y of the falling head
  speed: number;      // px/frame — varies per column for parallax depth
  chars: string[];    // trail of characters behind the head
  trailLength: number;
  isWord: boolean;    // word columns spell a heist term instead of noise
  word: string;       // the word being spelled (word columns only)
  wordIndex: number;  // next char index in `word`
  dim: boolean;       // dimmer columns add depth
  /** Counter for how many frames before the head char re-rolls. */
  headFlicker: number;
}

interface CyberRainBackgroundProps {
  /** Tailwind/inline opacity override. Default 0.12 — subtle texture. */
  opacity?: number;
}

export function CyberRainBackground({ opacity = 0.12 }: CyberRainBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const columnsRef = useRef<Column[]>([]);
  const isMountedRef = useRef<boolean>(true);
  // Mutable config kept in a ref so the animation loop reads live values
  // without needing to re-bind on every render.
  const configRef = useRef({
    fontSize: 14,
    columnWidth: 16,
    reducedMotion: false,
  });

  useEffect(() => {
    isMountedRef.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    configRef.current.reducedMotion = mql.matches;
    const handleMotionChange = (e: MediaQueryListEvent) => {
      if (!isMountedRef.current) return;
      configRef.current.reducedMotion = e.matches;
      if (e.matches) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else {
        if (document.visibilityState === "visible" && rafRef.current === null) {
          rafRef.current = requestAnimationFrame(loop);
        }
      }
    };
    mql.addEventListener("change", handleMotionChange);

    function setupColumns() {
      const { columnWidth } = configRef.current;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const cols = Math.max(1, Math.floor(w / columnWidth));
      const arr: Column[] = [];
      for (let i = 0; i < cols; i++) {
        const isWord = Math.random() < 0.08;
        arr.push(makeColumn(i * columnWidth, h, isWord));
      }
      columnsRef.current = arr;
    }

    function makeColumn(x: number, height: number, isWord: boolean): Column {
      return {
        x,
        y: Math.random() * -height,
        speed: 0.4 + Math.random() * 0.9,
        chars: [],
        trailLength: 8 + Math.floor(Math.random() * 18),
        isWord,
        word: isWord ? HEIST_WORDS[Math.floor(Math.random() * HEIST_WORDS.length)] : "",
        wordIndex: 0,
        dim: Math.random() < 0.35,
        headFlicker: 0,
      };
    }

    let resizeRafId: number | null = null;
    const resize = () => {
      if (resizeRafId !== null) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = null;
        if (!isMountedRef.current || !canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = window.innerWidth;
        const h = window.innerHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
        configRef.current.columnWidth = w < 640 ? 14 : 16;
        configRef.current.fontSize = w < 640 ? 12 : 14;
        ctx!.font = `${configRef.current.fontSize}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
        setupColumns();
        if (configRef.current.reducedMotion) drawStaticFrame();
      });
    };
    resize();
    window.addEventListener("resize", resize);

    const handleVisibility = () => {
      if (!isMountedRef.current) return;
      if (document.visibilityState === "hidden") {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      } else if (!configRef.current.reducedMotion && rafRef.current === null) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    function nextChar(col: Column): string {
      if (col.isWord) {
        const ch = col.word[col.wordIndex % col.word.length];
        col.wordIndex++;
        return ch;
      }
      return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
    }

    function drawColumn(col: Column) {
      const { fontSize } = configRef.current;
      const headColor = col.dim ? "rgba(244, 63, 94, 0.95)" : "rgba(239, 68, 68, 1)";
      const bodyColor = col.dim
        ? "rgba(244, 63, 94, 0.45)"
        : "rgba(239, 68, 68, 0.7)";
      const tailColor = col.dim
        ? "rgba(244, 63, 94, 0.12)"
        : "rgba(239, 68, 68, 0.22)";

      for (let i = 0; i < col.chars.length; i++) {
        const y = col.y - i * fontSize;
        if (y < -fontSize || y > window.innerHeight + fontSize) continue;
        let color: string;
        if (i === 0) color = headColor;
        else if (i < col.trailLength * 0.4) color = bodyColor;
        else color = tailColor;
        ctx!.fillStyle = color;
        const ch = col.chars[i];
        if (ch !== " ") ctx!.fillText(ch, col.x, y);
      }
    }

    function step(col: Column) {
      const { fontSize } = configRef.current;
      const h = window.innerHeight;
      col.y += col.speed;
      col.headFlicker++;
      if (col.headFlicker >= 3 + Math.floor(Math.random() * 5)) {
        col.headFlicker = 0;
        if (col.chars.length > 0) col.chars[0] = nextChar(col);
      }
      col.chars.unshift(nextChar(col));
      if (col.chars.length > col.trailLength) col.chars.pop();

      if (col.y - col.trailLength * fontSize > h) {
        const fresh = makeColumn(col.x, h, Math.random() < 0.08);
        Object.assign(col, fresh);
      }
    }

    function drawStaticFrame() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const col of columnsRef.current) {
        const count = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
          const y = Math.random() * window.innerHeight;
          ctx.fillStyle = col.dim
            ? "rgba(244, 63, 94, 0.15)"
            : "rgba(239, 68, 68, 0.25)";
          ctx.fillText(
            SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)],
            col.x,
            y,
          );
        }
      }
    }

    function loop() {
      if (!isMountedRef.current) return;
      ctx!.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx!.fillRect(0, 0, window.innerWidth, window.innerHeight);

      for (const col of columnsRef.current) {
        step(col);
        drawColumn(col);
      }

      if (!configRef.current.reducedMotion) {
        rafRef.current = requestAnimationFrame(loop);
      }
    }

    if (!configRef.current.reducedMotion && document.visibilityState === "visible") {
      rafRef.current = requestAnimationFrame(loop);
    } else {
      drawStaticFrame();
    }

    return () => {
      isMountedRef.current = false;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      mql.removeEventListener("change", handleMotionChange);
      if (resizeRafId !== null) {
        cancelAnimationFrame(resizeRafId);
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="fixed inset-0 w-full h-full z-0 pointer-events-none mix-blend-screen motion-reduce:hidden"
      style={{
        opacity,
      }}
    />
  );
}
