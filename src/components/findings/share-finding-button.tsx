"use client";

import React, { useState } from "react";
import { Share2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ShareFindingButtonProps {
  findingId: string;
  className?: string;
}

/**
 * ShareFindingButton Component
 *
 * Allows reviewers to copy the shareable finding URL to their clipboard.
 */
export function ShareFindingButton({ findingId, className = "" }: ShareFindingButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleShare = () => {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/dashboard/findings/${findingId}`
        : `/dashboard/findings/${findingId}`;

    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleShare}
      className={`gap-1.5 border-white/10 hover:bg-white/5 ${className}`}
      aria-label="Share finding link"
    >
      {copied ? (
        <>
          <Check className="w-3.5 h-3.5 text-green-400" />
          <span className="text-green-400">Link Copied!</span>
        </>
      ) : (
        <>
          <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
          <span>Share</span>
        </>
      )}
    </Button>
  );
}
export default ShareFindingButton;
