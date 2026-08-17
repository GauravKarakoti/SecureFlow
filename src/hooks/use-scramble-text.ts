import { useEffect, useRef, useState } from "react";

/** Pool of characters used as noise during the scramble transition. */
const SCRAMBLE_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@#$%!";

interface UseScrambleTextOptions {
  /** Text shown at rest (the codename). */
  from: string;
  /** Text revealed on hover (the real name). */
  to: string;
  /**
   * Direction of the animation.
   * - `true`  → scramble from `from` towards `to`
   * - `false` → scramble from `to`  back to `from`
   */
  isRevealing: boolean;
  /** Total animation duration in milliseconds. Default: 400. */
  duration?: number;
  /**
   * Fired once when the scramble animation settles on its target string.
   *
   * Useful for chaining sequential decode animations — e.g. the heist share
   * page terminal transmission (issue #250) advances to the next line as
   * soon as the previous one finishes decoding.
   *
   * The callback is stored in a ref so callers may pass inline closures
   * without restarting the animation on every render.
   */
  onComplete?: () => void;
}

/**
 * Returns a live-updating string that character-scrambles between `from`
 * and `to` whenever `isRevealing` flips, using `requestAnimationFrame`.
 *
 * Algorithm
 * ---------
 * Each frame we calculate a progress value t ∈ [0, 1].  Characters whose
 * index falls below `floor(t × maxLength)` are "locked" to their target
 * value; the rest are replaced with random characters from SCRAMBLE_CHARS.
 * This produces the classic left-to-right hacker-decode effect.
 *
 * The hook is dependency-free and runs entirely outside the React render
 * cycle via refs, so it never causes a cascade of unnecessary re-renders.
 */
export function useScrambleText({
  from,
  to,
  isRevealing,
  duration = 400,
  onComplete,
}: UseScrambleTextOptions): string {
  const [displayText, setDisplayText] = useState(from);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  // Skip animation on initial mount so the codename renders immediately.
  const isFirstRender = useRef(true);
  const onCompleteRef = useRef<(() => void) | undefined>(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // Cancel any in-progress animation frame before starting a new one.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    startTimeRef.current = null;

    const source = isRevealing ? from : to;
    const target = isRevealing ? to : from;
    const maxLen = Math.max(source.length, target.length);

    function animate(timestamp: number) {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // Number of characters already resolved to their final value.
      const lockedCount = Math.floor(progress * maxLen);

      let result = "";
      for (let i = 0; i < maxLen; i++) {
        if (i < lockedCount) {
          // Locked — snap to target character (empty string when target is shorter).
          result += target[i] ?? "";
        } else {
          // Scrambling — random noise character.
          result +=
            SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        }
      }

      setDisplayText(result);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        // Animation complete — set the clean final string and stop.
        setDisplayText(target);
        rafRef.current = null;
        // Notify the consumer that the decode has settled on `target`.
        onCompleteRef.current?.();
      }
    }

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isRevealing, from, to, duration]);

  return displayText;
}
