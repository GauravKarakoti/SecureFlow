"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Loader2, Wrench, X, Info } from "lucide-react";
import { PatchDiffViewer } from "@/components/findings/patch-diff-viewer";
import { useToast } from "@/hooks/use-toast";
import type { FindingRow } from "@/lib/actions/findings";

export interface BulkRemediationBarProps {
  selectedFindings: FindingRow[];
  onClearSelection?: () => void;
}

interface PatchResponseData {
  patchDiff: string;
  explanation: string;
  /** The selection the patch was generated for; see `selectionKey`. */
  selectionKey: string;
}

export default function BulkRemediationBar({
  selectedFindings,
  onClearSelection,
}: BulkRemediationBarProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; selectionKey: string } | null>(null);
  const [generatedPatch, setGeneratedPatch] = useState<PatchResponseData | null>(null);

  const count = selectedFindings.length;

  // The bar stays mounted while the selection changes, so a patch (or an error)
  // is only shown for the selection it was produced for. Without this, picking
  // different findings after generating kept offering the old combined diff for
  // `git apply`, and a response that landed after the selection changed was
  // shown against the new one.
  const selectionKey = useMemo(
    () => selectedFindings.map((f) => f.id).join(","),
    [selectedFindings],
  );
  const patchData = generatedPatch?.selectionKey === selectionKey ? generatedPatch : null;
  const errorMessage = error?.selectionKey === selectionKey ? error.message : null;

  // Extract unique vulnerability types across selected findings
  const selectedTypes = useMemo(() => {
    return Array.from(new Set(selectedFindings.map((f) => f.type)));
  }, [selectedFindings]);

  const isHomogeneous = selectedTypes.length === 1;
  const commonType = isHomogeneous ? selectedTypes[0] : null;

  if (count === 0) {
    return null;
  }

  const handleGeneratePatch = async () => {
    if (!isHomogeneous) {
      toast({
        variant: "destructive",
        title: "Incompatible Selection",
        description:
          "Bulk remediation requires all selected findings to be of the same vulnerability type.",
      });
      return;
    }

    const requestedFor = selectionKey;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/findings/bulk-remediate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          findingIds: selectedFindings.map((f) => f.id),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        const errorMsg = data.error || "Failed to generate bulk remediation patch.";
        setError({ message: errorMsg, selectionKey: requestedFor });
        toast({
          variant: "destructive",
          title: "Remediation Failed",
          description: errorMsg,
        });
        return;
      }

      setGeneratedPatch({
        patchDiff: data.patch.patchDiff,
        explanation: data.explanation,
        selectionKey: requestedFor,
      });

      toast({
        variant: "success",
        title: "Bulk Patch Generated 🛡️",
        description: `Generated combined patch for ${count} ${commonType} findings.`,
      });
    } catch {
      const errorMsg = "An unexpected error occurred while generating the bulk patch.";
      setError({ message: errorMsg, selectionKey: requestedFor });
      toast({
        variant: "destructive",
        title: "Remediation Error",
        description: errorMsg,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="space-y-3 rounded-xl border border-white/5 bg-white/5 p-4"
      data-testid="bulk-remediation-bar"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wrench className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <h4 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Bulk Remediation
          </h4>
        </div>
        <div className="flex items-center gap-2">
          {isHomogeneous && commonType ? (
            <Badge
              variant="outline"
              className="border-primary/20 bg-primary/5 text-primary text-[10px]"
            >
              {count} {commonType}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-amber-500/20 bg-amber-500/10 text-amber-400 text-[10px]"
            >
              Mixed Types ({selectedTypes.length})
            </Badge>
          )}
        </div>
      </div>

      {!isHomogeneous ? (
        <div
          className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-300"
          data-testid="bulk-remediation-mixed-warning"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <p className="font-semibold">Mixed vulnerability types selected</p>
              <p className="text-amber-200/80 mt-0.5">
                Bulk remediation requires all selected findings to be of the same vulnerability
                type. Selected: {selectedTypes.join(", ")}.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Generate a unified remediation patch covering all {count} selected {commonType} findings
          across the repository.
        </p>
      )}

      {errorMessage && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
          {errorMessage}
        </div>
      )}

      {!patchData ? (
        <Button
          size="sm"
          className="w-full"
          disabled={!isHomogeneous || loading}
          onClick={handleGeneratePatch}
          data-testid="generate-bulk-patch-button"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Generating Bulk Patch…
            </>
          ) : (
            <>
              <Wrench className="w-4 h-4 mr-2" />
              Generate Bulk Remediation Patch
            </>
          )}
        </Button>
      ) : (
        <div className="space-y-3 pt-2" data-testid="bulk-patch-review">
          <div className="flex items-center justify-between">
            <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Review Combined Patch
            </h5>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => setGeneratedPatch(null)}
            >
              <X className="w-3 h-3 mr-1" />
              Close Diff
            </Button>
          </div>

          <PatchDiffViewer patchDiff={patchData.patchDiff} explanation={patchData.explanation} />

          <div className="flex items-start gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-300">
            <Info className="h-4 w-4 shrink-0 text-blue-400 mt-0.5" />
            <p>
              Copy the unified diff above to review and apply it locally across your repository
              files using{" "}
              <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-blue-200">
                git apply
              </code>
              .
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
