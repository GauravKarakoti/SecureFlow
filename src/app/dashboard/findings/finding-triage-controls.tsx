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
import { useToast } from "@/hooks/use-toast";
import {
  setFindingStatus,
  setFindingStatusBulk,
  type BulkTriageTarget,
  TriageStatus,
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

interface FindingTriageControlsProps {
  repositoryId: string;
  fingerprint: string;
  currentStatus: TriageStatus;
  currentNote: string | null;
}

export default function FindingTriageControls({
  repositoryId,
  fingerprint,
  currentStatus,
  currentNote,
}: FindingTriageControlsProps) {
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
            description: `Finding status updated to ${STATUS_OPTIONS.find((o) => o.value === status)?.label}. Vault security updated.`,
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
          {STATUS_OPTIONS.find((o) => o.value === currentStatus)?.label}
        </Badge>
      </div>

      <Select value={status} onValueChange={(v) => setStatus(v as TriageStatus)} disabled={isPending}>
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

interface BulkTriageBarProps {
  /** The findings currently selected, resolved to their triage targets. */
  targets: BulkTriageTarget[];
  /** Clear the selection after a successful bulk action. */
  onDone: () => void;
}

/**
 * Action bar for triaging many findings at once (#732).
 *
 * Rendered by the findings list only while at least one finding is selected. It
 * wraps {@link setFindingStatusBulk}, which reuses the same ownership check and
 * audit trail as the single-finding control above.
 */
export function BulkTriageBar({ targets, onDone }: BulkTriageBarProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TriageStatus>("RESOLVED");
  const [note, setNote] = useState("");

  const count = targets.length;

  const apply = () => {
    startTransition(async () => {
      try {
        const result = await setFindingStatusBulk({ targets, status, note });
        if (result.ok) {
          toast({
            variant: "success",
            title: "PLAN EXECUTED: BULK TRIAGE RECORDED 🛡️",
            description: `${result.updated} ${result.updated === 1 ? "finding" : "findings"} updated to ${BULK_STATUS_OPTIONS.find((o) => o.value === status)?.label}.`,
          });
          setNote("");
          onDone();
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
      }
    });
  };

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

      <Button size="sm" onClick={apply} disabled={count === 0 || isPending}>
        {isPending ? "Applying…" : `Apply to ${count}`}
      </Button>
    </div>
  );
}
