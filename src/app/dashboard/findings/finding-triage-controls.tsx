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

function BulkTriageControls({ targets }: { targets: FindingTriageTarget[] }) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [pendingStatus, setPendingStatus] = useState<TriageStatus | null>(null);

  if (targets.length === 0) {
    return null;
  }

  const apply = (status: TriageStatus) => {
    startTransition(async () => {
      try {
        const result = await setFindingStatuses({ items: targets, status, note });
        if (result.ok) {
          toast({
            variant: "success",
            title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
            description: `${targets.length} findings updated to ${statusLabel(status)}. Vault security updated.`,
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
      } finally {
        setPendingStatus(null);
      }
    });
  };

  const pendingLabel = pendingStatus ? statusLabel(pendingStatus) : "";

  return (
    <div className="space-y-3 rounded-xl border border-white/5 bg-white/5 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
          Bulk triage
        </h4>
        <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
          {targets.length} on this page
        </Badge>
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
          disabled={isPending}
          onClick={() => setPendingStatus("IGNORED")}
        >
          {isPending && pendingStatus === "IGNORED" ? "Saving…" : "Dismiss all"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() => setPendingStatus("FALSE_POSITIVE")}
        >
          {isPending && pendingStatus === "FALSE_POSITIVE" ? "Saving…" : "Mark as false positive"}
        </Button>
      </div>

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
              This will mark {targets.length} {targets.length === 1 ? "finding" : "findings"} on
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
