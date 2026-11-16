"use client";

import { useState } from "react";
import { Edit3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { editPolicy } from "./actions";
import { useToast } from "@/hooks/use-toast";
import { POLICY_SEVERITIES } from "@/lib/policies/versioning";

interface PolicyEditModalProps {
  policyId: string;
  policyName: string;
  currentDescription: string;
  currentSeverity: string;
  isOpen: boolean;
  onClose: () => void;
}

export function PolicyEditModal({
  policyId,
  policyName,
  currentDescription,
  currentSeverity,
  isOpen,
  onClose,
}: PolicyEditModalProps) {
  const { toast } = useToast();
  const [description, setDescription] = useState(currentDescription);
  const [severity, setSeverity] = useState(currentSeverity);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) {
      toast({
        variant: "destructive",
        title: "Validation error",
        description: "Policy description cannot be empty",
      });
      return;
    }

    setIsSaving(true);
    try {
      const res = await editPolicy({
        templateId: policyId,
        description: description.trim(),
        severity,
      });

      if (!res.ok) {
        throw new Error(res.error || "Failed to update policy");
      }

      toast({
        title: "Policy updated",
        description: `Successfully saved version ${res.versionNumber}.`,
      });
      onClose();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: err?.message || "Failed to update policy",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg bg-zinc-950 border border-white/10 text-white p-6">
        <DialogHeader className="pb-2 border-b border-white/10">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Edit3 className="w-5 h-5 text-primary" />
            Edit Policy: {policyName}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Modifying this policy will automatically save a new version to the audit history.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className="space-y-4 pt-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Severity</label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-full bg-zinc-900 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="edit-policy-severity-select"
            >
              <option value="CRITICAL">CRITICAL</option>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
              <option value="INFO">INFO</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Description</label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter policy description..."
              className="w-full bg-zinc-900 border border-white/10 rounded-md p-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              data-testid="edit-policy-description-input"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isSaving}
              className="hover:bg-white/10 text-zinc-400 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving}
              data-testid="save-policy-edit-button"
              className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
