import React from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { getCweUrl, isValidCwe, normalizeCwe } from "@/lib/cwe";

interface CweBadgeProps {
  cwe?: string | null;
  className?: string;
  showLink?: boolean;
}

/**
 * Renders a standardized CWE badge with an optional external link to the MITRE definition.
 * If cwe is empty or not provided, renders null so existing findings without CWE render seamlessly (#2008).
 */
export function CweBadge({ cwe, className = "", showLink = true }: CweBadgeProps) {
  if (!cwe || typeof cwe !== "string") {
    return null;
  }

  const normalized = normalizeCwe(cwe);
  const url = getCweUrl(normalized);

  const badgeContent = (
    <Badge
      variant="outline"
      className={`border-sky-500/30 bg-sky-500/10 text-sky-400 font-mono text-[10px] shrink-0 inline-flex items-center gap-1 hover:bg-sky-500/20 transition-colors ${className}`}
      title={`Common Weakness Enumeration: ${normalized}`}
      data-testid="cwe-badge"
    >
      <span>{normalized}</span>
      {showLink && url && <ExternalLink className="w-2.5 h-2.5 opacity-70" aria-hidden="true" />}
    </Badge>
  );

  if (showLink && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center"
        aria-label={`View definition for ${normalized}`}
      >
        {badgeContent}
      </a>
    );
  }

  return badgeContent;
}

export default CweBadge;
