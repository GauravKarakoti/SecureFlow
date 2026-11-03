"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  { value: "none", label: "No expiry" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

type SingleFindingTriageControlsProps = {
  repositoryId: string;
  fingerprint: string;
  currentStatus: TriageStatus;
  currentNote: string | null;
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

function computeExpiryDate(days: string): Date | null {
  if (days === "none" || !days) return null;
  const numDays = parseInt(days, 10);
  if (Number.isNaN(numDays) || numDays <= 0) return null;
  return new Date(Date.now() + numDays * 24 * 60 * 60 * 1000);
}

function isExpiryLapsed(expiryDate: Date | null): boolean {
  if (!expiryDate) return false;
  return expiryDate.getTime() <= Date.now();
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
  currentExpiresAt,
}: SingleFindingTriageControlsProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TriageStatus>(currentStatus);
  const [reason, setReason] = useState<DismissalReason>("FALSE_POSITIVE");
  const [note, setNote] = useState(currentNote ?? "");
  const [expirySelection, setExpirySelection] = useState<string>("none");

  const isDismissal = status === "DISMISSED" || status === "FALSE_POSITIVE" || status === "IGNORED";
  const dirty =
    status !== currentStatus ||
    note !== (currentNote ?? "") ||
    (isDismissal && expirySelection !== "none");

  // Determine current expiry status for UI badge/text
  const currentExpiryDate = currentExpiresAt ? new Date(currentExpiresAt) : null;
  const isLapsed = isExpiryLapsed(currentExpiryDate);

  const save = () => {
    if (status === "DISMISSED" && !note.trim()) {
      toast({
        variant: "destructive",
        title: "Reason required",
        description: "Please provide a reason note when dismissing a finding.",
      });
      return;
    }
    startTransition(async () => {
      try {
        const computedExpiry = isDismissal ? computeExpiryDate(expirySelection) : null;
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
            description: `Finding status updated to ${statusLabel(status)}. Vault security updated.`,
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

      <Select
        value={status}
        onValueChange={(v) => {
          setStatus(v as TriageStatus);
          if (v !== "FALSE_POSITIVE" && v !== "IGNORED") {
            setExpirySelection("none");
          }
        }}
        disabled={isPending}
      >
        <SelectTrigger className="h-9 text-sm">
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
            disabled={isPending}
          >
            <SelectTrigger className="h-9 text-sm">
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
          <Select value={expirySelection} onValueChange={setExpirySelection} disabled={isPending}>
            <SelectTrigger className="h-9 text-sm" data-testid="triage-expiry-select">
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

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={status === "DISMISSED" ? "Required note (why is this being dismissed?)" : "Optional note (why is this being resolved?)"}
        rows={2}
        disabled={isPending}
        className="text-sm"
      />

      <Button size="sm" onClick={save} disabled={!dirty || isPending} className="w-full">
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
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [pendingStatus, setPendingStatus] = useState<TriageStatus | null>(null);
  const [expiryDays, setExpiryDays] = useState<string>("none");

  const count = targets.length;

  if (count === 0) {
    return null;
  }

  const apply = (applyStatus: TriageStatus) => {
    startTransition(async () => {
      try {
        if (applyStatus === "DISMISSED" && !note.trim()) {
          toast({
            variant: "destructive",
            title: "Reason note required",
            description: "Please provide a reason note when dismissing findings.",
          });
          return;
        }
        const isDismissal = applyStatus === "DISMISSED" || applyStatus === "FALSE_POSITIVE" || applyStatus === "IGNORED";
        const computedExpiry = isDismissal ? computeExpiryDate(expiryDays) : null;

        const result = await setFindingStatuses({
          items: targets,
          status: applyStatus,
          reason: applyStatus === "DISMISSED" ? "FALSE_POSITIVE" : undefined,
          note,
          expiresAt: computedExpiry,
        });
        if (result.ok) {
          toast({
            variant: "success",
            title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
            description: `${count} findings updated to ${statusLabel(applyStatus)}. Vault security updated.`,
          });
          setNote("");
          setExpiryDays("none");
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

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Dismissal Expiry (for False Positive / Ignored)
        </label>
        <Select value={expiryDays} onValueChange={setExpiryDays} disabled={isPending}>
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

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note for this bulk action"
        rows={2}
        disabled={isPending}
        className="text-sm"
      />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingStatus("DISMISSED")}
          disabled={isPending}
          className="border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingStatus("RESOLVED")}
          disabled={isPending}
          className="border-green-500/20 bg-green-500/10 text-green-300 hover:bg-green-500/20 hover:text-green-200"
        >
          Mark Resolved
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingStatus("FALSE_POSITIVE")}
          disabled={isPending}
          className="border-zinc-500/20 bg-zinc-500/10 text-zinc-300 hover:bg-zinc-500/20 hover:text-white"
        >
          Mark False positive
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingStatus("IGNORED")}
          disabled={isPending}
          className="border-zinc-500/20 bg-zinc-500/10 text-zinc-300 hover:bg-zinc-500/20 hover:text-white"
        >
          Mark Ignored
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPendingStatus("OPEN")}
          disabled={isPending}
          className="border-primary/20 bg-primary/10 text-primary hover:bg-primary/20"
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
                (pendingStatus === "FALSE_POSITIVE" || pendingStatus === "IGNORED") && (
                  <> with {expiryDays === "none" ? "no expiry" : `${expiryDays} days expiry`}</>
                )}
              . This updates the database and creates an audit entry for each finding.
            </AlertDialogDescription>
          </AlertDialogHeader>
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
