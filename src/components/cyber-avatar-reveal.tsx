"use client";

import Image from "next/image";
import { VenetianMask } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The three phases the component cycles through:
 *
 *  idle       → mask fully visible,  avatar fully hidden   (no animation class)
 *  revealing  → cyber-mask-out  +  cyber-avatar-in         (hover begins)
 *  concealing → cyber-mask-in   +  cyber-avatar-out        (cursor leaves)
 *
 * After the concealing animations finish we reset to idle so the next hover
 * starts fresh from a clean DOM state.
 */
type AvatarPhase = "idle" | "revealing" | "concealing";

interface CyberAvatarRevealProps {
  /** GitHub avatar URL.  If absent, a glitch-only effect is shown. */
  image?: string | null;
  /** User's display name — used as accessible aria-label. */
  name?: string | null;
}

/**
 * Renders a VenetianMask icon by default.
 * On hover, a CSS clip-path + filter glitch animation dissolves the mask away
 * while the user's GitHub avatar materialises from scan-line noise beneath it.
 * On mouse leave the animation plays in reverse.
 *
 * Implementation notes
 * --------------------
 * • All animation work is done entirely in CSS keyframes (`globals.css`).
 *   No canvas, no Web Animations API, no external library.
 * • The animation uses clip-path inset() horizontal slices, hue-rotate /
 *   saturate / brightness filters, and translate jitter — properties the
 *   browser composites on the GPU so the effect runs at 60 fps without
 *   triggering layout or paint.
 * • animation-fill-mode: forwards keeps each layer at its final keyframe
 *   state, so intermediate states don't snap or flash between phases.
 * • The outer wrapper carries the glow ring box-shadow (no overflow:hidden)
 *   while the inner wrapper clips translate overflow from the animations.
 */
export function CyberAvatarReveal({ image, name }: CyberAvatarRevealProps) {
  const [phase, setPhase] = useState<AvatarPhase>("idle");

  const handleEnter = () => setPhase("revealing");
  const handleLeave = () => (image ? setPhase("concealing") : setPhase("idle"));

  // Reset to idle once the mask has fully re-built after concealing.
  // We listen on the mask element's animationend because cyber-mask-in is the
  // last animation to complete in the concealing phase.
  const handleMaskAnimEnd = () => {
    if (phase === "concealing") setPhase("idle");
  };

  // ── Fallback: no GitHub avatar — glitch the icon itself on hover ──────────
  if (!image) {
    return (
      <div
        className={cn(
          "w-8 h-8 rounded-full bg-primary/20 border border-primary/30",
          "flex items-center justify-center shrink-0 cursor-default",
          // Smooth glow ring via transition (not part of the glitch anim).
          "transition-shadow duration-300",
          "hover:shadow-[0_0_0_2px_rgba(229,9,20,0.6),0_0_12px_2px_rgba(229,9,20,0.25)]",
          phase === "revealing" && "cyber-icon-glitch",
        )}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setPhase("idle")}
        // Once the 2-iteration glitch finishes, clean up the phase.
        onAnimationEnd={() => setPhase("idle")}
        aria-label={name ?? "Profile — identity masked"}
        role="img"
      >
        <VenetianMask className="w-5 h-5 text-red-500" />
      </div>
    );
  }

  // ── Primary: VenetianMask ↔ GitHub avatar glitch swap ────────────────────
  return (
    /*
     * Outer div: provides the glow ring (box-shadow) and cursor.
     * No overflow:hidden here — that would clip the box-shadow.
     */
    <div
      className={cn(
        "w-8 h-8 rounded-full shrink-0 cursor-default",
        "transition-shadow duration-300",
        phase !== "idle" &&
          "shadow-[0_0_0_2px_rgba(229,9,20,0.6),0_0_12px_2px_rgba(229,9,20,0.25)]",
      )}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      aria-label={name ?? "Profile"}
      role="img"
    >
      {/*
       * Inner div: overflow:hidden clips any translate() overflow produced
       * during the glitch animation so pixels don't bleed outside the circle.
       */}
      <div className="relative w-full h-full rounded-full overflow-hidden">

        {/* ── Layer 1: VenetianMask (default visible, glitches out on hover) ── */}
        <div
          className={cn(
            "absolute inset-0 rounded-full z-10",
            "bg-primary/20 border border-primary/30",
            "flex items-center justify-center",
            phase === "revealing"  && "cyber-mask-out",
            phase === "concealing" && "cyber-mask-in",
          )}
          // When idle, show at full opacity (no animation class to override).
          // When not idle, the animation handles opacity via keyframes.
          style={{ opacity: phase === "idle" ? 1 : undefined }}
          onAnimationEnd={handleMaskAnimEnd}
        >
          <VenetianMask className="w-5 h-5 text-red-500" />
        </div>

        {/* ── Layer 2: GitHub avatar (hidden by default, glitches in on hover) ── */}
        <div
          className={cn(
            "absolute inset-0 z-0",
            phase === "revealing"  && "cyber-avatar-in",
            phase === "concealing" && "cyber-avatar-out",
          )}
          style={{ opacity: phase === "idle" ? 0 : undefined }}
        >
          <Image
            src={image}
            alt={name ?? "Profile"}
            fill
            sizes="32px"
            className="rounded-full object-cover border border-primary/30"
          />
        </div>

      </div>
    </div>
  );
}
