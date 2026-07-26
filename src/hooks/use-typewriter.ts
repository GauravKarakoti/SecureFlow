import { useState, useEffect, useRef } from "react";

/**
 * Buffers incoming streaming text and outputs it at a strict, steady pace
 * to create a typewriter effect, regardless of network chunking speed.
 */
export function useTypewriter(incomingText: string | null, speedMs: number = 30) {
  const [displayedText, setDisplayedText] = useState("");
  const currentIndex = useRef(0);

  useEffect(() => {
    if (!incomingText) {
      currentIndex.current = 0;
      const timer = setTimeout(() => setDisplayedText(""), 0);
      return () => clearTimeout(timer);
    }

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
