"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { can } from "@/lib/auth/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  setFindingStatus,
  setFindingStatuses,
  type FindingTriageTarget,
  type TriageStatus,
  type DismissalReason,
} from "@/lib/actions/triage";
import { computeExpiryDate } from "@/lib/triage/expiry";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const STATUS_OPTIONS: { value: TriageStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "FALSE_POSITIVE", label: "False positive (legacy)" },
  { value: "IGNORED", label: "Ignored (legacy)" },
];

const DISMISSAL_REASON_OPTIONS: { value: DismissalReason; label: string }[] = [
  { value: "FALSE_POSITIVE", label: "False positive" },
  { value: "ACCEPTED_RISK", label: "Accepted risk" },
  { value: "WONT_FIX", label: "Won't fix" },
];

const STATUS_BADGE: Record<TriageStatus, string> = {
  OPEN: "bg-primary/10 text-primary border-primary/20",
  DISMISSED: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  RESOLVED: "bg-green-500/10 text-green-400 border-green-500/20",
  FALSE_POSITIVE: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
  IGNORED: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
};

const EXPIRY_OPTIONS = [
  { value: "none", label: "No expiry (permanent)" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "end_of_quarter", label: "End of quarter" },
  { value: "custom", label: "Custom date" },
] as const;

type SingleFindingTriageControlsProps = {
  repositoryId: string;
  fingerprint: string;
  currentStatus: TriageStatus;
  currentNote: string | null;
  currentReason?: DismissalReason | null;
  currentExpiresAt?: Date | string | null;
};

type BulkFindingTriageControlsProps = {
  variant: "bulk";
  targets: FindingTriageTarget[];
};

type FindingTriageControlsProps = SingleFindingTriageControlsProps | BulkFindingTriageControlsProps;

function isBulkProps(props: FindingTriageControlsProps): props is BulkFindingTriageControlsProps {
  return "variant" in props && props.variant === "bulk";
}

function statusLabel(status: TriageStatus): string {
  return STATUS_OPTIONS.find((option) => option.value === status)?.label ?? status;
}

function isExpiryLapsed(expiryDate: Date | null, nowMs: number): boolean {
  if (!expiryDate) return false;
  return expiryDate.getTime() <= nowMs;
}

export default function FindingTriageControls(props: FindingTriageControlsProps) {
  if (isBulkProps(props)) {
    return <BulkTriageControls {...props} />;
  }

  return <SingleTriageControls {...props} />;
}

function SingleTriageControls({
  repositoryId,
  fingerprint,
  currentStatus,
  currentNote,
  currentReason,
  currentExpiresAt,
}: SingleFindingTriageControlsProps) {
  const { toast } = useToast();
  const router = useRouter();
  const { data: session } = useSession();
  const canTriage = session?.user ? can(session.user, repositoryId, "findings:dismiss") : true;
  const [isPending, startTransition] = useTransition();
  const [nowMs] = useState(() => Date.now());
  const [status, setStatus] = useState<TriageStatus>(currentStatus);
  const [reason, setReason] = useState<DismissalReason>(currentReason ?? "FALSE_POSITIVE");
  const [note, setNote] = useState(currentNote ?? "");
  const [expirySelection, setExpirySelection] = useState<string>("none");
  const [customDate, setCustomDate] = useState<string>("");

  const isDismissal = status === "DISMISSED" || status === "FALSE_POSITIVE" || status === "IGNORED";
  const dirty =
    status !== currentStatus ||
    note !== (currentNote ?? "") ||
    (status === "DISMISSED" && reason !== (currentReason ?? "FALSE_POSITIVE")) ||
    (isDismissal && expirySelection !== "none") ||
    (isDismissal && expirySelection === "custom" && customDate !== "");

  // Determine current expiry status for UI badge/text
  const currentExpiryDate = currentExpiresAt ? new Date(currentExpiresAt) : null;
  const isLapsed = isExpiryLapsed(currentExpiryDate, nowMs);

  const save = () => {
    startTransition(async () => {
      try {
        const computedExpiry = isDismissal ? computeExpiryDate(expirySelection, customDate) : null;
        const result = await setFindingStatus({
          repositoryId,
          fingerprint,
          status,
          reason: status === "DISMISSED" ? reason : undefined,
          note,
          expiresAt: computedExpiry,
        });
        if (result.ok) {
          toast({
            variant: "success",
            title: "PLAN EXECUTED: TRIAGE RECORDED 🛡️",
            description:
              result.warning ??
              `Finding status updated to ${statusLabel(status)}. Vault security updated.`,
          });
          router.refresh();
        } else {
          toast({
            variant: "destructive",
            title: "Couldn't update triage",
            description: result.error ?? "An unexpected error occurred.",
          });
        }
      } catch {
        toast({
          variant: "destructive",
          title: "Couldn't update triage",
          description: "An unexpected error occurred. Please try again.",
        });
      }
    });
  };

  return (
    <div className="space-y-3 rounded-xl border border-white/5 bg-white/5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Triage
        </h4>
        <div className="flex items-center gap-1.5">
          {currentExpiryDate && (
            <Badge
              variant="outline"
              className={
                isLapsed
                  ? "border-red-500/20 bg-red-500/10 text-red-400"
                  : "border-amber-500/20 bg-amber-500/10 text-amber-300"
              }
            >
              {isLapsed ? "expired" : `expires on ${currentExpiryDate.toLocaleDateString()}`}
            </Badge>
          )}
          <Badge variant="outline" className={STATUS_BADGE[currentStatus]}>
            {statusLabel(currentStatus)}
          </Badge>
        </div>
      </div>

      {!canTriage && (
        <div className="rounded border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-300">
          Read-only view: You need Triager or Admin permissions to triage findings.
        </div>
      )}

      <Select
        value={status}
        onValueChange={(v) => {
          setStatus(v as TriageStatus);
          if (v !== "FALSE_POSITIVE" && v !== "IGNORED" && v !== "DISMISSED") {
            setExpirySelection("none");
            setCustomDate("");
          }
        }}
        disabled={!canTriage || isPending}
      >
        <SelectTrigger className="min-h-[44px] text-sm" data-testid="triage-status-select">
          <SelectValue placeholder="Set status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {status === "DISMISSED" && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Dismissal Reason</label>
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as DismissalReason)}
            disabled={!canTriage || isPending}
          >
            <SelectTrigger className="min-h-[44px] text-sm" data-testid="triage-reason-select">
              <SelectValue placeholder="Select reason" />
            </SelectTrigger>
            <SelectContent>
              {DISMISSAL_REASON_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isDismissal && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Dismissal Expiry</label>
          <Select value={expirySelection} onValueChange={setExpirySelection} disabled={!canTriage || isPending}>
            <SelectTrigger className="min-h-[44px] text-sm" data-testid="triage-expiry-select">
              <SelectValue placeholder="Select expiry period" />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isDismissal && expirySelection === "custom" && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Custom Expiry Date (max 1 year)
          </label>
          <Input
            type="date"
            min={new Date(nowMs).toISOString().slice(0, 10)}
            max={new Date(nowMs + ONE_YEAR_MS).toISOString().slice(0, 10)}
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            disabled={!canTriage || isPending}
            data-testid="triage-custom-expiry-input"
            className="min-h-[44px] text-sm"
          />
        </div>
      )}

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          status === "DISMISSED"
            ? "Optional note (why is this being dismissed?)"
            : "Optional note (why is this being resolved?)"
        }
        rows={2}
        disabled={!canTriage || isPending}
        className="text-sm min-h-[44px]"
      />

      <Button
        size="default"
        onClick={save}
        disabled={!canTriage || !dirty || isPending}
        className="w-full min-h-[44px]"
        data-testid="save-triage-button"
      >
        {isPending ? "Saving…" : "Save triage"}
      </Button>
    </div>
  );
}

export interface BulkTriageBarProps {
  /** The findings currently selected, resolved to their triage targets. */
  targets: FindingTriageTarget[];
  /** Clear the selection after a successful bulk action. */
  onDone?: () => void;
}

/**
 * Action bar for triaging many findings at once (#732, #1503).
 */
export function BulkTriageBar({ targets, onDone }: BulkTriageBarProps) {
  const { toast } = useToast();
  const router = useRouter();
  const { data: session } = useSession();
  const canTriage = session?.user ? can(session.user, targets[0]?.repositoryId || null, "findings:dismiss") : true;
  const [isPending, startTransition] = useTransition();
  const [nowMs] = useState(() => Date.now());
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<DismissalReason>("FALSE_POSITIVE");
  const [pendingStatus, setPendingStatus] = useState<TriageStatus | null>(null);
  const [expiryDays, setExpiryDays] = useState<string>("none");
  const [customExpiryDate, setCustomExpiryDate] = useState<string>("");

  const count = targets.length;

  if (count === 0) {
    return null;
  }

  const apply = (applyStatus: TriageStatus) => {
    startTransition(async () => {
      try {
        const isDismissal =
          applyStatus === "DISMISSED" ||
          applyStatus === "FALSE_POSITIVE" ||
          applyStatus === "IGNORED";
        const computedExpiry = isDismissal ? computeExpiryDate(expiryDays, customExpiryDate) : null;

        const result = await setFindingStatuses({
          items: targets,
          status: applyStatus,
          reason: applyStatus === "DISMISSED" ? reason : undefined,
          note,
          expiresAt: computedExpiry,
        });
        if (result.ok) {
          toast({
            variant: result.skippedCount && result.skippedCount > 0 ? "default" : "success",
            title:
              result.skippedCount && result.skippedCount > 0
                ? "Bulk triage completed with warnings"
                : "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
            description:
              result.warning ??
              `${count} findings updated to ${statusLabel(applyStatus)}. Vault security updated.`,
          });
          setNote("");
          setExpiryDays("none");
          setCustomExpiryDate("");
          onDone?.();
          router.refresh();
        } else {
          toast({
            variant: "destructive",
            title: "Couldn't update findings",
            description: result.error ?? "An unexpected error occurred.",
          });
        }
      } catch {
        toast({
          variant: "destructive",
          title: "Couldn't update findings",
          description: "An unexpected error occurred. Please try again.",
        });
      } finally {
        setPendingStatus(null);
      }
    });
  };

  const pendingLabel = pendingStatus ? statusLabel(pendingStatus) : "";

  return (
    <div
      className="space-y-3 rounded-xl border border-white/5 bg-white/5 p-4"
      data-testid="bulk-triage-bar"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Bulk triage
        </h4>
        <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
          {count} on this page
        </Badge>
      </div>

      {!canTriage && (
        <div className="rounded border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-300">
          Read-only view: You need Triager or Admin permissions to perform bulk triage.
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Dismissal Expiry</label>
        <Select value={expiryDays} onValueChange={setExpiryDays} disabled={!canTriage || isPending}>
          <SelectTrigger className="h-9 text-sm" data-testid="bulk-triage-expiry-select">
            <SelectValue placeholder="Select expiry period" />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {expiryDays === "custom" && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Custom Expiry Date (max 1 year)
          </label>
          <Input
            type="date"
            min={new Date(nowMs).toISOString().slice(0, 10)}
            max={new Date(nowMs + ONE_YEAR_MS).toISOString().slice(0, 10)}
            value={customExpiryDate}
            onChange={(e) => setCustomExpiryDate(e.target.value)}
            disabled={!canTriage || isPending}
            data-testid="bulk-triage-custom-expiry-input"
            className="h-9 text-sm"
          />
        </div>
      )}

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for this bulk action"
        rows={2}
        disabled={!canTriage || isPending}
        className="text-sm"
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button
          size="default"
          variant="outline"
          onClick={() => setPendingStatus("DISMISSED")}
          disabled={!canTriage || isPending}
          className="min-h-[44px] border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
          aria-label="Dismiss selected"
          data-testid="dismiss-selected-button"
        >
          Dismiss selected
        </Button>
        <Button
          size="default"
          variant="outline"
          onClick={() => setPendingStatus("RESOLVED")}
          disabled={!canTriage || isPending}
          className="min-h-[44px] border-green-500/20 bg-green-500/10 text-green-300 hover:bg-green-500/20 hover:text-green-200"
        >
          Mark Resolved
        </Button>
        <Button
          size="default"
          variant="outline"
          onClick={() => setPendingStatus("FALSE_POSITIVE")}
          disabled={!canTriage || isPending}
          className="min-h-[44px] border-zinc-500/20 bg-zinc-500/10 text-zinc-300 hover:bg-zinc-500/20 hover:text-white"
        >
          Mark False positive
        </Button>
        <Button
          size="default"
          variant="outline"
          onClick={() => setPendingStatus("IGNORED")}
          disabled={!canTriage || isPending}
          className="min-h-[44px] border-zinc-500/20 bg-zinc-500/10 text-zinc-300 hover:bg-zinc-500/20 hover:text-white"
        >
          Mark Ignored
        </Button>
        <Button
          size="default"
          variant="outline"
          onClick={() => setPendingStatus("OPEN")}
          disabled={!canTriage || isPending}
          className="min-h-[44px] border-primary/20 bg-primary/10 text-primary hover:bg-primary/20"
        >
          Reopen
        </Button>
      </div>

      <AlertDialog
        open={pendingStatus !== null}
        onOpenChange={(open) => {
          if (!open) setPendingStatus(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply bulk triage to {count} findings?</AlertDialogTitle>
            <AlertDialogDescription>
              Every finding selected on this page will be marked as <strong>{pendingLabel}</strong>
              {pendingStatus &&
                (pendingStatus === "FALSE_POSITIVE" ||
                  pendingStatus === "IGNORED" ||
                  pendingStatus === "DISMISSED") && (
                  <>
                    {" "}
                    with{" "}
                    {expiryDays === "none"
                      ? "no expiry"
                      : expiryDays === "custom"
                        ? `expiry on ${customExpiryDate}`
                        : expiryDays === "end_of_quarter"
                          ? "expiry at end of quarter"
                          : `${expiryDays} days expiry`}
                  </>
                )}
              . This updates the database and creates an audit entry for each finding.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingStatus === "DISMISSED" && (
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as DismissalReason)}
              disabled={isPending}
            >
              <SelectTrigger aria-label="Dismissal reason">
                <SelectValue placeholder="Choose reason" />
              </SelectTrigger>
              <SelectContent>
                {DISMISSAL_REASON_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingStatus) apply(pendingStatus);
              }}
              disabled={isPending}
            >
              {isPending ? "Applying…" : "Apply to all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BulkTriageControls({ targets }: Pick<BulkFindingTriageControlsProps, "targets">) {
  return <BulkTriageBar targets={targets} />;
}
