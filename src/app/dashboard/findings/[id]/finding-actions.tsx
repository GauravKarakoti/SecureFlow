"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Trash2, ShieldCheck, AlertTriangle } from "lucide-react";
import type { TriageStatus } from "@/lib/triage/statuses";

const STATUS_OPTIONS: { value: TriageStatus; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "RESOLVED", label: "Resolved" },
  { value: "FALSE_POSITIVE", label: "False Positive" },
  { value: "IGNORED", label: "Ignored" },
];

const SEVERITY_OPTIONS = [
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "MEDIUM", label: "Medium" },
  { value: "LOW", label: "Low" },
  { value: "INFO", label: "Info" },
];

const STATUS_BADGE: Record<TriageStatus, string> = {
  OPEN: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  RESOLVED: "bg-green-500/10 text-green-400 border-green-500/20",
  FALSE_POSITIVE: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  IGNORED: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

interface FindingActionsProps {
  findingId: string;
  initialSeverity: string;
  initialTriageStatus?: TriageStatus;
  initialNote?: string | null;
}

/**
 * FindingActions provides interactive triage status updates, severity changes,
 * and finding deletion, powered directly by REST endpoints at /api/findings/[id] (PATCH and DELETE).
 */
export default function FindingActions({
  findingId,
  initialSeverity,
  initialTriageStatus = "OPEN",
  initialNote = "",
}: FindingActionsProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [triageStatus, setTriageStatus] = useState<TriageStatus>(initialTriageStatus);
  const [severity, setSeverity] = useState<string>(initialSeverity);
  const [note, setNote] = useState<string>(initialNote ?? "");
  const [isUpdating, startUpdateTransition] = useTransition();
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const isDirty =
    triageStatus !== initialTriageStatus ||
    severity !== initialSeverity ||
    note !== (initialNote ?? "");

  const handleUpdate = () => {
    startUpdateTransition(async () => {
      try {
        const payload: { triageStatus?: string; severity?: string; note?: string } = {};
        if (triageStatus !== initialTriageStatus) {
          payload.triageStatus = triageStatus;
        }
        if (severity !== initialSeverity) {
          payload.severity = severity;
        }
        if (note !== (initialNote ?? "")) {
          payload.note = note;
        }

        const res = await fetch(`/api/findings/${findingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(data?.message || data?.error || `Failed to update finding (${res.status})`);
        }

        toast({
          variant: "success",
          title: "Finding updated",
          description: "Triage status and severity were successfully saved.",
        });

        router.refresh();
      } catch (err) {
        toast({
          variant: "destructive",
          title: "Update failed",
          description: err instanceof Error ? err.message : "An unexpected error occurred.",
        });
      }
    });
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/findings/${findingId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message || data?.error || `Failed to delete finding (${res.status})`);
      }

      toast({
        variant: "success",
        title: "Finding deleted",
        description: "The finding has been removed from the repository scan results.",
      });

      setDeleteDialogOpen(false);
      router.push("/dashboard/findings");
      router.refresh();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Deletion failed",
        description: err instanceof Error ? err.message : "An unexpected error occurred.",
      });
      setIsDeleting(false);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Triage & Management</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Current:</span>
          <Badge variant="outline" className={STATUS_BADGE[triageStatus]}>
            {STATUS_OPTIONS.find((s) => s.value === triageStatus)?.label || triageStatus}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Triage Status Selector */}
        <div className="space-y-1.5">
          <label htmlFor="triage-status-select" className="text-xs font-medium text-muted-foreground">
            Triage Status
          </label>
          <Select
            value={triageStatus}
            onValueChange={(val) => setTriageStatus(val as TriageStatus)}
            disabled={isUpdating || isDeleting}
          >
            <SelectTrigger id="triage-status-select" className="h-9 text-xs">
              <SelectValue placeholder="Select status" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Severity Selector */}
        <div className="space-y-1.5">
          <label htmlFor="severity-select" className="text-xs font-medium text-muted-foreground">
            Adjust Severity
          </label>
          <Select
            value={severity}
            onValueChange={(val) => setSeverity(val)}
            disabled={isUpdating || isDeleting}
          >
            <SelectTrigger id="severity-select" className="h-9 text-xs">
              <SelectValue placeholder="Select severity" />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Note input */}
      <div className="space-y-1.5">
        <label htmlFor="triage-note" className="text-xs font-medium text-muted-foreground">
          Triage Note (optional)
        </label>
        <Textarea
          id="triage-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Document reason for triage status or severity change..."
          rows={2}
          disabled={isUpdating || isDeleting}
          className="text-xs"
        />
      </div>

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
        {/* Delete Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isUpdating || isDeleting}
              className="w-full sm:w-auto text-destructive hover:bg-destructive/10 hover:text-destructive border-destructive/20 gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Finding
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-white/10 bg-background">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-destructive" />
                Delete this security finding?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This action permanently removes the finding and any associated remediation records
                from your scan history. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleDelete();
                }}
                disabled={isDeleting}
                className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              >
                {isDeleting ? "Deleting..." : "Confirm Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Button
          type="button"
          size="sm"
          onClick={handleUpdate}
          disabled={!isDirty || isUpdating || isDeleting}
          className="w-full sm:w-auto min-w-[120px]"
        >
          {isUpdating ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
