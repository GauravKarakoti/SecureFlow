"use client";

import { useState } from "react";
import { Edit3, Loader2, Sparkles, AlertCircle, TrendingDown, TrendingUp } from "lucide-react";
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
import type { PolicyPreviewImpactResult } from "@/lib/policies/preview-impact";

const SEVERITY_ROWS = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

interface PolicyEditModalProps {
  policyId: string;
  policyName: string;
  currentDescription: string;
  currentSeverity: string;
  currentHelpUrl?: string | null;
  currentGuidance?: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export function PolicyEditModal({
  policyId,
  policyName,
  currentDescription,
  currentSeverity,
  currentHelpUrl,
  currentGuidance,
  isOpen,
  onClose,
}: PolicyEditModalProps) {
  const { toast } = useToast();
  const [description, setDescription] = useState(currentDescription);
  const [severity, setSeverity] = useState(currentSeverity);
  const [helpUrl, setHelpUrl] = useState(currentHelpUrl ?? "");
  const [guidance, setGuidance] = useState(currentGuidance ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<PolicyPreviewImpactResult | null>(null);

  const handlePreview = async () => {
    if (!description.trim()) {
      toast({
        variant: "destructive",
        title: "Validation error",
        description: "Policy description cannot be empty to preview impact",
      });
      return;
    }

    setIsPreviewLoading(true);
    setPreviewResult(null);

    try {
      const response = await fetch("/api/policies/preview-impact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: policyId,
          draftDescription: description.trim(),
          draftSeverity: severity,
        }),
      });

      const res = await response.json();

      if (!response.ok || !res.ok) {
        throw new Error(res.error || "Failed to preview policy impact");
      }

      setPreviewResult(res as PolicyPreviewImpactResult);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Preview failed",
        description: err?.message || "Failed to generate policy impact preview",
      });
    } finally {
      setIsPreviewLoading(false);
    }
  };

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

    if (helpUrl.trim() && !helpUrl.trim().startsWith("https://")) {
      toast({
        variant: "destructive",
        title: "Validation error",
        description: "Policy help URL must use https:// protocol",
      });
      return;
    }

    setIsSaving(true);
    try {
      const res = await editPolicy({
        templateId: policyId,
        description: description.trim(),
        severity,
        helpUrl: helpUrl.trim() || undefined,
        guidance: guidance.trim() || undefined,
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
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-zinc-950 border border-white/10 text-white p-6">
        <DialogHeader className="pb-2 border-b border-white/10">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Edit3 className="w-5 h-5 text-primary" />
            Edit Policy: {policyName}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Preview the impact on recent PR scans before deploying this change to production.
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
            <div className="flex justify-between items-center">
              <label className="text-xs font-semibold text-zinc-300">Description</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePreview}
                disabled={isPreviewLoading || isSaving || !description.trim()}
                data-testid="preview-impact-button"
                className="min-h-[44px] text-xs gap-1.5 border-primary/30 hover:border-primary/50 text-primary hover:text-primary hover:bg-primary/10 px-3 py-2"
              >
                {isPreviewLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5" />
                )}
                {isPreviewLoading ? "Replaying Scans..." : "Preview Impact"}
              </Button>
            </div>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Enter policy description..."
              className="w-full bg-zinc-900 border border-white/10 rounded-md p-3 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              data-testid="edit-policy-description-input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">
              Help URL (How to fix link - must use https://)
            </label>
            <input
              type="url"
              value={helpUrl}
              onChange={(e) => setHelpUrl(e.target.value)}
              placeholder="https://..."
              className="w-full bg-zinc-900 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="edit-policy-help-url-input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Short Guidance Text</label>
            <input
              type="text"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder="Explain how developers should fix violations..."
              className="w-full bg-zinc-900 border border-white/10 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="edit-policy-guidance-input"
            />
          </div>

          {/* Impact Preview Section */}
          {isPreviewLoading && (
            <div
              data-testid="preview-impact-loading"
              className="rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center justify-center gap-3 text-sm text-zinc-300"
            >
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
              <span>Replaying historical scan inputs against current & draft policy...</span>
            </div>
          )}

          {previewResult && (
            <div
              data-testid="preview-impact-result"
              className="rounded-lg border border-white/10 bg-zinc-900/60 p-4 space-y-4"
            >
              {!previewResult.hasHistory ? (
                <div
                  data-testid="preview-empty-history"
                  className="flex items-start gap-3 text-amber-400/90 text-sm p-3 bg-amber-500/10 rounded-md border border-amber-500/20"
                >
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">
                      Too little history exists for a meaningful preview
                    </p>
                    <p className="text-xs text-zinc-400 mt-1">
                      {previewResult.message ||
                        "No historical scan inputs were found for your repositories. Scans must be completed before an impact preview can be generated."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Top Stats */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/10">
                    <div>
                      <h4 className="text-sm font-semibold tracking-tight text-white flex items-center gap-2">
                        <span>Impact Analysis Summary</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-primary/20 text-primary border border-primary/30 font-normal">
                          {previewResult.replayedScans} scans replayed
                        </span>
                      </h4>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        ~{previewResult.totalTokens.toLocaleString()} tokens simulated • Zero
                        database writes • No check runs posted
                      </p>
                    </div>
                  </div>

                  {/* Summary Metric Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded border border-red-500/20 bg-red-500/5 p-2.5">
                      <div className="text-xs text-zinc-400">New Findings</div>
                      <div className="text-lg font-bold text-red-400 flex items-center gap-1">
                        <TrendingUp className="w-4 h-4" />+
                        {previewResult.severityComparison.TOTAL.newCount}
                      </div>
                    </div>
                    <div className="rounded border border-green-500/20 bg-green-500/5 p-2.5">
                      <div className="text-xs text-zinc-400">Removed</div>
                      <div className="text-lg font-bold text-green-400 flex items-center gap-1">
                        <TrendingDown className="w-4 h-4" />-
                        {previewResult.severityComparison.TOTAL.removedCount}
                      </div>
                    </div>
                    <div className="rounded border border-white/10 bg-white/5 p-2.5">
                      <div className="text-xs text-zinc-400">Unchanged</div>
                      <div className="text-lg font-bold text-zinc-300">
                        {previewResult.severityComparison.TOTAL.unchanged}
                      </div>
                    </div>
                    <div className="rounded border border-primary/20 bg-primary/5 p-2.5">
                      <div className="text-xs text-zinc-400">Net Change</div>
                      <div
                        className={`text-lg font-bold ${
                          previewResult.severityComparison.TOTAL.netChange > 0
                            ? "text-red-400"
                            : previewResult.severityComparison.TOTAL.netChange < 0
                              ? "text-green-400"
                              : "text-zinc-300"
                        }`}
                      >
                        {previewResult.severityComparison.TOTAL.netChange > 0
                          ? `+${previewResult.severityComparison.TOTAL.netChange}`
                          : previewResult.severityComparison.TOTAL.netChange}
                      </div>
                    </div>
                  </div>

                  {/* Comparison Table */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-semibold text-zinc-300">
                      <span>Severity Comparison</span>
                      <span className="sm:hidden text-[10px] font-mono text-zinc-400">
                        Scroll horizontally &rarr;
                      </span>
                    </div>
                    <div className="overflow-x-auto rounded border border-white/10">
                      <table
                        data-testid="severity-comparison-table"
                        className="w-full text-xs text-left min-w-[480px]"
                      >
                        <thead className="sticky top-0 bg-zinc-900 border-b border-white/10 text-zinc-400 z-10">
                          <tr>
                            <th className="py-2 px-3">Severity</th>
                            <th className="py-2 px-3 text-center">Unchanged</th>
                            <th className="py-2 px-3 text-center text-red-400">New (+)</th>
                            <th className="py-2 px-3 text-center text-green-400">Removed (-)</th>
                            <th className="py-2 px-3 text-center">Net Change</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5 font-mono">
                          {SEVERITY_ROWS.map((sev) => {
                            const row = previewResult.severityComparison[sev];
                            if (
                              row.unchanged === 0 &&
                              row.newCount === 0 &&
                              row.removedCount === 0
                            ) {
                              return null;
                            }
                            return (
                              <tr key={sev} className="hover:bg-white/5">
                                <td className="py-1.5 px-3 font-semibold font-sans">{sev}</td>
                                <td className="py-1.5 px-3 text-center text-zinc-400">
                                  {row.unchanged}
                                </td>
                                <td className="py-1.5 px-3 text-center text-red-400">
                                  {row.newCount > 0 ? `+${row.newCount}` : "0"}
                                </td>
                                <td className="py-1.5 px-3 text-center text-green-400">
                                  {row.removedCount > 0 ? `-${row.removedCount}` : "0"}
                                </td>
                                <td className="py-1.5 px-3 text-center font-bold">
                                  {row.netChange > 0 ? `+${row.netChange}` : row.netChange}
                                </td>
                              </tr>
                            );
                          })}
                          <tr className="bg-white/5 font-bold border-t border-white/10">
                            <td className="py-2 px-3 font-sans">TOTAL</td>
                            <td className="py-2 px-3 text-center text-zinc-300">
                              {previewResult.severityComparison.TOTAL.unchanged}
                            </td>
                            <td className="py-2 px-3 text-center text-red-400">
                              +{previewResult.severityComparison.TOTAL.newCount}
                            </td>
                            <td className="py-2 px-3 text-center text-green-400">
                              -{previewResult.severityComparison.TOTAL.removedCount}
                            </td>
                            <td className="py-2 px-3 text-center">
                              {previewResult.severityComparison.TOTAL.netChange > 0
                                ? `+${previewResult.severityComparison.TOTAL.netChange}`
                                : previewResult.severityComparison.TOTAL.netChange}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Findings breakdown if new or removed exist */}
                  {(previewResult.findings.new.length > 0 ||
                    previewResult.findings.removed.length > 0) && (
                    <div className="space-y-2 pt-2 border-t border-white/10">
                      <div className="text-xs font-semibold text-zinc-300">
                        Affected Findings Detail
                      </div>
                      <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs">
                        {previewResult.findings.new.map((f, idx) => (
                          <div
                            key={`new-${idx}`}
                            className="p-2 rounded bg-red-500/10 border border-red-500/20 text-zinc-200"
                          >
                            <div className="flex items-center gap-1.5 text-red-400 font-semibold mb-0.5">
                              <span className="px-1.5 py-0.2 rounded bg-red-500/20 text-[10px]">
                                NEW
                              </span>
                              <span>[{f.severity}]</span>
                              <span>{f.type}</span>
                              <span className="text-zinc-400 font-mono text-[10px]">
                                in {f.fileLocation}
                                {f.lineStart ? `:${f.lineStart}` : ""}
                              </span>
                            </div>
                            <p className="text-zinc-300">{f.description}</p>
                          </div>
                        ))}
                        {previewResult.findings.removed.map((f, idx) => (
                          <div
                            key={`rem-${idx}`}
                            className="p-2 rounded bg-green-500/10 border border-green-500/20 text-zinc-200"
                          >
                            <div className="flex items-center gap-1.5 text-green-400 font-semibold mb-0.5">
                              <span className="px-1.5 py-0.2 rounded bg-green-500/20 text-[10px]">
                                DISAPPEARS
                              </span>
                              <span>[{f.severity}]</span>
                              <span>{f.type}</span>
                              <span className="text-zinc-400 font-mono text-[10px]">
                                in {f.fileLocation}
                                {f.lineStart ? `:${f.lineStart}` : ""}
                              </span>
                            </div>
                            <p className="text-zinc-300">{f.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t border-white/10">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isSaving}
              className="hover:bg-white/10 text-zinc-400 hover:text-white min-h-[44px]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSaving}
              data-testid="save-policy-edit-button"
              className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground min-h-[44px]"
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
