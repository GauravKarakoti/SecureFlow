import * as React from "react";
import {
  AlertOctagon,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { normalizeSeverity, type Severity } from "@/lib/severity";
import { getSeverityTheme } from "@/lib/severity-theme";
import { cn } from "@/lib/utils";

export interface SeverityBadgeProps extends Omit<BadgeProps, "children"> {
  severity: unknown;
  showIcon?: boolean;
  showCanonical?: boolean;
  children?: React.ReactNode;
}

const SEVERITY_ICONS: Record<Severity, LucideIcon> = {
  CRITICAL: AlertOctagon,
  HIGH: AlertTriangle,
  MEDIUM: AlertCircle,
  LOW: Info,
  NONE: CheckCircle2,
};

/**
 * SeverityBadge Component
 *
 * Provides accessible presentation for vulnerability severity levels.
 * Complies with WCAG AA guidelines by:
 * - Not relying on color alone: includes distinct contextual icons beside each severity.
 * - Enforcing high contrast color pairs for both light and dark themes.
 * - Providing descriptive `role="status"` and `aria-label` screen reader announcements.
 */
export function SeverityBadge({
  severity,
  showIcon = true,
  showCanonical = false,
  className,
  children,
  ...props
}: SeverityBadgeProps) {
  const theme = getSeverityTheme(severity);
  const canonical = normalizeSeverity(severity, "NONE");
  const Icon = SEVERITY_ICONS[canonical] || AlertCircle;

  const accessibleLabel = `Severity: ${canonical} - ${theme.label}`;

  return (
    <Badge
      role="status"
      aria-label={props["aria-label"] || accessibleLabel}
      title={props.title || `Severity: ${canonical}`}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold tracking-normal shadow-sm",
        theme.badgeClass,
        className,
      )}
      {...props}
    >
      {showIcon && <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      <span>{children || (showCanonical ? `${canonical}: ${theme.label}` : theme.label)}</span>
    </Badge>
  );
}

export default SeverityBadge;
