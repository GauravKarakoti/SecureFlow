"use client";

import React, { useState } from "react";
import { CheckCircle2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface RemediationGuidanceCardProps {
  remediation?: string | null | undefined;
  className?: string;
}

const DEFAULT_REMEDIATION =
  "Follow standard security practices to sanitize input and isolate privileges.";

/**
 * RemediationGuidanceCard Component
 *
 * Displays security remediation guidance alongside the vulnerable code context,
 * with a one-click copy button to easily copy the suggested fix.
 */
export function RemediationGuidanceCard({
  remediation,
  className = "",
}: RemediationGuidanceCardProps) {
  const [copied, setCopied] = useState(false);

  const textToCopy = remediation && remediation.trim() ? remediation : DEFAULT_REMEDIATION;

  const handleCopy = () => {
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      data-testid="remediation-guidance-card"
      className={`rounded-xl border border-green-500/20 bg-green-950/10 p-5 space-y-3 ${className}`}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold text-green-400 uppercase tracking-widest flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          Remediation Guidance
        </h4>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 px-2.5 text-xs text-green-300 hover:text-green-100 hover:bg-green-500/10 gap-1.5"
          aria-label="Copy remediation suggestion"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-green-400" />
              <span className="text-green-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>Copy Fix</span>
            </>
          )}
        </Button>
      </div>

      <div
        data-testid="remediation-text"
        className="text-sm text-foreground/90 leading-relaxed p-4 bg-white/[0.03] border border-white/5 rounded-lg whitespace-pre-wrap font-sans"
      >
        {textToCopy}
      </div>
    </div>
  );
}
export default RemediationGuidanceCard;
