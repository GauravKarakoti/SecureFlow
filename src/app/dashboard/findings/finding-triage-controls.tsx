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
} from "@/lib/actions/triage";

const STATUS_OPTIONS: { value: TriageStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "FALSE_POSITIVE", label: "False positive" },
  { value: "IGNORED", label: "Ignored" },
];

const STATUS_BADGE: Record<TriageStatus, string> = {
  OPEN: "bg-primary/10 text-primary border-primary/20",
  RESOLVED: "bg-green-500/10 text-green-400 border-green-500/20",
  FALSE_POSITIVE: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
  IGNORED: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
};

type SingleFindingTriageControlsProps = {
  repositoryId: string;
  fingerprint: string;
  currentStatus: TriageStatus;
  currentNote: string | null;
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

export default function FindingTriageControls(props: FindingTriageControlsProps) {
  if (isBulkProps(props)) {
    return <BulkTriageControls targets={props.targets} />;
  }

  return <SingleTriageControls {...props} />;
}

function SingleTriageControls({
  repositoryId,
  fingerprint,
  currentStatus,
  currentNote,
}: SingleFindingTriageControlsProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TriageStatus>(currentStatus);
  const [note, setNote] = useState(currentNote ?? "");

  const dirty = status !== currentStatus || note !== (currentNote ?? "");

  const save = () => {
    startTransition(async () => {
      try {
        const result = await setFindingStatus({ repositoryId, fingerprint, status, note });
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
        <Badge variant="outline" className={STATUS_BADGE[currentStatus]}>
          {statusLabel(currentStatus)}
        </Badge>
      </div>

      <Select
        value={status}
        onValueChange={(v) => setStatus(v as TriageStatus)}
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

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (why is this being dismissed / resolved?)"
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

/** Statuses offered for a bulk action — OPEN is excluded (it is the "un-triage" default). */
const BULK_STATUS_OPTIONS: { value: TriageStatus; label: string }[] = [
  { value: "RESOLVED", label: "Resolved" },
  { value: "FALSE_POSITIVE", label: "False positive" },
  { value: "IGNORED", label: "Ignored" },
];

export interface BulkTriageBarProps {
  /** The findings currently selected, resolved to their triage targets. */
  targets: FindingTriageTarget[];
  /** Clear the selection after a successful bulk action. */
  onDone?: () => void;
}

/**
 * Action bar for triaging many findings at once (#732).
 *
 * Rendered by the findings list only while at least one finding is selected. It
 * wraps {@link setFindingStatuses}, which reuses the same ownership check and
 * audit trail as the single-finding control above.
 */
export function BulkTriageBar({ targets, onDone }: BulkTriageBarProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TriageStatus>("RESOLVED");
  const [note, setNote] = useState("");
  const [pendingStatus, setPendingStatus] = useState<TriageStatus | null>(null);

  const count = targets.length;

  if (count === 0) {
    return null;
  }

  const apply = (applyStatus: TriageStatus) => {
    startTransition(async () => {
      try {
        const result = await setFindingStatuses({ items: targets, status: applyStatus, note });
        if (result.ok) {
          toast({
            variant: "success",
            title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
            description: `${count} ${count === 1 ? "finding" : "findings"} updated to ${statusLabel(applyStatus)}. Vault security updated.`,
          });
          setNote("");
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
      className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
      data-testid="bulk-triage-bar"
    >
      <span className="text-sm font-semibold">
        {count} {count === 1 ? "finding" : "findings"} selected
      </span>

      <Select value={status} onValueChange={(v) => setStatus(v as TriageStatus)} disabled={isPending}>
        <SelectTrigger className="h-9 w-[170px] text-sm" aria-label="Bulk triage status">
          <SelectValue placeholder="Set status" />
        </SelectTrigger>
        <SelectContent>
          {BULK_STATUS_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note applied to all selected findings"
        rows={1}
        disabled={isPending}
        className="min-w-[220px] flex-1 text-sm"
        aria-label="Bulk triage note"
      />

      <Button size="sm" onClick={() => setPendingStatus(status)} disabled={count === 0 || isPending}>
        {isPending && pendingStatus !== null ? "Applying…" : `Apply to ${count}`}
      </Button>

      <AlertDialog
        open={pendingStatus !== null && !isPending}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingStatus(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply bulk triage?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark {count} {count === 1 ? "finding" : "findings"} on
              this page as {pendingLabel}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingStatus) apply(pendingStatus);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BulkTriageControls({ targets }: { targets: FindingTriageTarget[] }) {
  return <BulkTriageBar targets={targets} />;
}