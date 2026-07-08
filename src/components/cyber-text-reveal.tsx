"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useScrambleText } from "@/hooks/use-scramble-text";

interface CyberTextRevealProps {
  /** The user's codename — displayed at rest. */
  codename?: string | null;
  /** The user's real name — revealed on hover via scramble animation. */
  realName?: string | null;
  className?: string;
}

/**
 * Renders a codename that digitally scrambles into the user's real name on
 * hover, then reconstructs back on mouse-leave.
 *
 * Accessibility
 * -------------
 * The `aria-label` always exposes the real identity to screen readers so
 * scrambled intermediate characters are never announced.  The element uses
 * `role="text"` and `select-none` to prevent accidental copy of noise chars.
 *
 * Layout stability
 * ----------------
 * `minWidth` is set to the longer of the two strings (in `ch` units) so the
 * breadcrumb row never shifts during the animation.
 */
export function CyberTextReveal({
  codename,
  realName,
  className,
}: CyberTextRevealProps) {
  const [isRevealing, setIsRevealing] = useState(false);

  const from = codename ?? "Recruit";
  // Animation only makes sense when a distinct real name is available.
  const canReveal = !!realName && realName !== codename;
  const to = canReveal ? realName! : from;

  const displayText = useScrambleText({ from, to, isRevealing, duration: 400 });

  return (
    <span
      className={cn(
        "font-mono tracking-wider text-muted-foreground",
        "cursor-default select-none",
        // Smooth colour shift to primary on reveal — intentionally kept as a
        // simple transition because the scramble itself is the dramatic effect.
        "transition-colors duration-300",
        isRevealing && canReveal && "text-primary",
        className,
      )}
      style={{
        // Reserve the width of the longer string so the layout never jumps.
        display: "inline-block",
        minWidth: `${Math.max(from.length, to.length)}ch`,
      }}
      onMouseEnter={() => canReveal && setIsRevealing(true)}
      onMouseLeave={() => canReveal && setIsRevealing(false)}
      // Screen readers hear the real identity, not the scrambled characters.
      aria-label={to}
      role="text"
    >
      {displayText}
    </span>
  );
}
