"use client";

import { useState, useTransition } from "react";
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
import { setFindingStatus, TriageStatus } from "@/lib/actions/triage";

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
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TriageStatus>(currentStatus);
  const [note, setNote] = useState(currentNote ?? "");

  const dirty = status !== currentStatus || note !== (currentNote ?? "");

  const save = () => {
    startTransition(async () => {
      const result = await setFindingStatus({ repositoryId, fingerprint, status, note });
      if (result.ok) {
        toast({
          title: "Triage updated",
          description: `Finding marked as ${STATUS_OPTIONS.find((o) => o.value === status)?.label}.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Couldn't update triage",
          description: result.error ?? "An unexpected error occurred.",
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
