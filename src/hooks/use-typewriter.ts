import { useState, useEffect, useRef } from "react";

/**
 * Buffers incoming streaming text and outputs it at a strict, steady pace
 * to create a typewriter effect, regardless of network chunking speed.
 */
export function useTypewriter(incomingText: string | null, speedMs: number = 30) {
  const [displayedText, setDisplayedText] = useState("");
  const currentIndex = useRef(0);
  /** The text `currentIndex` counts into. */
  const typedText = useRef("");

  useEffect(() => {
    if (!incomingText) {
      currentIndex.current = 0;
      typedText.current = "";
      const timer = setTimeout(() => setDisplayedText(""), 0);
      return () => clearTimeout(timer);
    }

    // A stream appends, so the new text normally extends what has been typed
    // and the reveal carries on from where it was. Anything else is a different
    // text: without starting over, a shorter replacement never passed the
    // `currentIndex < length` check and the old text stayed on screen, and a
    // longer one jumped straight to the old position.
    if (!incomingText.startsWith(typedText.current.slice(0, currentIndex.current))) {
      currentIndex.current = 0;
      setDisplayedText("");
    }
    typedText.current = incomingText;

    const interval = setInterval(() => {
      if (currentIndex.current < incomingText.length) {
        setDisplayedText(incomingText.substring(0, currentIndex.current + 1));
        currentIndex.current += 1;
      }
    }, speedMs);

    return () => clearInterval(interval);
  }, [incomingText, speedMs]);

  return incomingText ? displayedText : "";
}
