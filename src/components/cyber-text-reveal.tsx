"use client";

import { useEffect, useRef, useState, type ElementType } from "react";
import { cn } from "@/lib/utils";
import { useScrambleText } from "@/hooks/use-scramble-text";

type CyberTextRevealVariant = "hover" | "transmission";

interface CyberTextRevealProps {
  /** Hover mode: the user's codename — displayed at rest. */
  codename?: string | null;
  /** Hover mode: the user's real name — revealed on hover via scramble animation. */
  realName?: string | null;
  /** Transmission mode: the message to auto-decode from noise on mount. */
  text?: string | null;
  /**
   * Transmission mode: override the scrambled "from" placeholder.  Defaults
   * to a row of full-block glyphs the same length as `text` so the layout
   * reserves the right amount of horizontal space before decoding.
   */
  placeholder?: string;
  /**
   * Interaction mode.
   * - `"hover"` (default) — existing codename ↔ realName scramble on hover.
   * - `"transmission"` — auto-decode `text` from noise on mount, used by the
   *   heist share page terminal transmission (issue #250).
   */
  variant?: CyberTextRevealVariant;
  /** Transmission mode: ms to wait before the decode begins. Default 0. */
  delay?: number;
  /** Animation duration in ms. Default 400. */
  duration?: number;
  /** Transmission mode: fires once the decode settles on `text`. */
  onRevealComplete?: () => void;
  /** Render as a different element — use `"div"` / `"p"` for block-level lines. */
  as?: ElementType;
  className?: string;
}

/**
 * Default placeholder used in transmission mode when none is supplied: a row
 * of full-block glyphs the same length as the target text.  In a monospace
 * font each `█` is exactly `1ch` wide, so the reserved width matches the
 * decoded payload and the layout never jumps mid-animation.
 */
function defaultPlaceholder(text: string): string {
  return "█".repeat(Math.max(text.length, 1));
}

/**
 * Renders a codename that digitally scrambles into the user's real name on
 * hover, then reconstructs back on mouse-leave.
 *
 * Variant: `"transmission"`
 * -------------------------
 * When `variant="transmission"` the component ignores hover and instead
 * auto-decodes `text` from a noise placeholder on mount (after `delay` ms).
 * This powers the heist share page's "encrypted terminal transmission from
 * the Professor" effect — multiple instances are chained sequentially by
 * the parent via `onRevealComplete`.
 *
 * Accessibility
 * -------------
 * The `aria-label` always exposes the real identity / decrypted payload to
 * screen readers so scrambled intermediate characters are never announced.
 * The element uses `role="text"` and `select-none` to prevent accidental
 * copy of noise chars.
 *
 * Layout stability
 * ----------------
 * `minWidth` is set to the longer of the two strings (in `ch` units) so the
 * surrounding row never shifts during the animation.
 */
export function CyberTextReveal({
  codename,
  realName,
  text,
  placeholder,
  variant = "hover",
  delay = 0,
  duration = 400,
  onRevealComplete,
  as,
  className,
}: CyberTextRevealProps) {
  const Comp = as ?? "span";
  const [isRevealing, setIsRevealing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards against `onRevealComplete` firing more than once per decode cycle.
  const completedRef = useRef(false);

  const isTransmission = variant === "transmission";

  // ── Resolve source/target strings per variant ───────────────────────────
  // Hover mode semantics (existing behaviour, unchanged).
  const hoverFrom = codename ?? "Recruit";
  const hoverCanReveal = !!realName && realName !== codename;
  const hoverTo = hoverCanReveal ? realName! : hoverFrom;

  // Transmission mode semantics: placeholder noise ↔ target text.
  const transmissionTarget =
    text !== null && text !== undefined && text.trim() !== "" ? text : null;
  const transmissionFrom = placeholder ?? defaultPlaceholder(transmissionTarget ?? "");
  const transmissionTo = transmissionTarget ?? transmissionFrom;

  const from = isTransmission ? transmissionFrom : hoverFrom;
  const to = isTransmission ? transmissionTo : hoverTo;

  const displayText = useScrambleText({
    from,
    to,
    isRevealing,
    duration,
    onComplete: () => {
      // Only forward completion in transmission mode — hover mode toggles
      // back and forth and has no consumer awaiting a "done" signal.
      if (isTransmission && !completedRef.current) {
        completedRef.current = true;
        onRevealComplete?.();
      }
    },
  });

  // ── Transmission mode: kick off the decode on mount (after `delay`) ─────
  // The effect restarts the decode whenever the target text or delay changes
  // so a parent reusing the component for a new payload gets a fresh cycle.
  useEffect(() => {
    if (!isTransmission) return;
    completedRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsRevealing(false);

    timerRef.current = setTimeout(
      () => {
        setIsRevealing(true);
      },
      Math.max(delay, 0),
    );

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // `to` is derived from `text`/`placeholder`; depending on it restarts
    // the decode when the payload changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTransmission, delay, to]);

  // ── Hover mode (existing) ───────────────────────────────────────────────
  if (!isTransmission) {
    return (
      <span
        className={cn(
          "font-mono tracking-wider text-muted-foreground",
          "cursor-default select-none",
          // Smooth colour shift to primary on reveal — intentionally kept as a
          // simple transition because the scramble itself is the dramatic effect.
          "transition-colors duration-300",
          isRevealing && hoverCanReveal && "text-primary",
          className,
        )}
        style={{
          // Reserve the width of the longer string so the layout never jumps.
          display: "inline-block",
          minWidth: `${Math.max(from.length, to.length)}ch`,
        }}
        onMouseEnter={() => hoverCanReveal && setIsRevealing(true)}
        onMouseLeave={() => hoverCanReveal && setIsRevealing(false)}
        aria-hidden="true"
      >
        {displayText}
        <span className="sr-only">{to}</span>
      </span>
    );
  }

  // ── Transmission mode (new) ─────────────────────────────────────────────
  return (
    <>
      <Comp
        className={cn(
          "font-mono tracking-wider select-none",
          "transition-colors duration-300",
          // Pre-decode the placeholder reads as dim "encrypted" data; once the
          // decode starts the line brightens to the foreground so the resolved
          // payload reads as freshly decrypted terminal output.
          isRevealing ? "text-foreground" : "text-muted-foreground/60",
          className,
        )}
        style={{
          // Block elements need `display: block`; inline stays inline.
          display: Comp !== "span" ? "block" : "inline-block",
          minWidth: `${Math.max(from.length, to.length)}ch`,
        }}
        aria-hidden="true"
      >
        {displayText}
      </Comp>
      <span className="sr-only">{to}</span>
    </>
  );
}
