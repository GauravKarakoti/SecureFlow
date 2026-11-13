"use client";

import { useState } from "react";
import { History, RotateCcw, AlertTriangle, ArrowLeftRight, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { computeTextDiff, type PolicyVersionDto } from "@/lib/policies/versioning";
import { getPolicyVersions, rollbackPolicy } from "./actions";
import { useToast } from "@/hooks/use-toast";

interface PolicyHistoryModalProps {
  policyId: string;
  policyName: string;
  currentDescription: string;
  currentSeverity: string;
  isOpen: boolean;
  onClose: () => void;
}

export function PolicyHistoryModal({
  policyId,
  policyName,
  currentDescription,
  currentSeverity,
  isOpen,
  onClose,
}: PolicyHistoryModalProps) {
  const { toast } = useToast();
  const [versions, setVersions] = useState<PolicyVersionDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [isRollingBack, setIsRollingBack] = useState(false);

  const fetchVersions = async () => {
    setIsLoading(true);
    try {
      const data = await getPolicyVersions(policyId);
      setVersions(data);
      if (data.length > 0) {
        setSelectedVersionId(data[0].id);
      }
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error loading history",
        description: err?.message || "Failed to load policy versions",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) {
      fetchVersions();
    } else {
      onClose();
    }
  };

  const selectedVersion = versions.find((v) => v.id === selectedVersionId);

  const handleRollback = async () => {
    if (!selectedVersion) return;
    setIsRollingBack(true);
    try {
      const res = await rollbackPolicy({
        templateId: policyId,
        versionId: selectedVersion.id,
      });

      if (!res.ok) {
        throw new Error(res.error || "Failed to rollback policy");
      }

      toast({
        title: "Policy restored",
        description: `Restored to version ${selectedVersion.versionNumber}. Created version ${res.versionNumber}.`,
      });
      onClose();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Rollback failed",
        description: err?.message || "Failed to restore version",
      });
    } finally {
      setIsRollingBack(false);
    }
  };

  const diffLines = selectedVersion
    ? computeTextDiff(selectedVersion.description, currentDescription)
    : [];

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl bg-zinc-950 border border-white/10 text-white p-6 max-h-[85vh] flex flex-col">
        <DialogHeader className="pb-2 border-b border-white/10">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <History className="w-5 h-5 text-primary" />
            Version History: {policyName}
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Compare past modifications side-by-side or rollback to any previous version.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center p-12 text-muted-foreground gap-2">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <span className="text-xs">Loading version history...</span>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-center p-8 text-zinc-400 border border-dashed border-white/10 rounded-lg my-4">
            No previous versions recorded for this policy yet. Edit this policy to start generating
            version history.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-1 min-h-0 pt-3">
            {/* Version List Sidebar */}
            <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1 border-r border-white/10">
              <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
                Versions ({versions.length})
              </div>
              {versions.map((ver) => (
                <button
                  key={ver.id}
                  onClick={() => setSelectedVersionId(ver.id)}
                  data-testid={`version-item-${ver.versionNumber}`}
                  className={`w-full text-left p-2.5 rounded-lg border transition-all text-xs ${
                    selectedVersionId === ver.id
                      ? "bg-primary/10 border-primary/40 text-white"
                      : "bg-white/5 border-white/5 text-zinc-400 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span>Version {ver.versionNumber}</span>
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[10px] text-zinc-300">
                      {ver.severity}
                    </span>
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-1">
                    {new Date(ver.createdAt).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                    by {ver.editor?.name || ver.editor?.codename || ver.editor?.email || "User"}
                  </div>
                </button>
              ))}
            </div>

            {/* Diff and Details View */}
            <div className="md:col-span-2 flex flex-col min-h-0 space-y-3">
              {selectedVersion && (
                <>
                  <div className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10 text-xs">
                    <div>
                      <span className="text-zinc-400">Comparing </span>
                      <strong className="text-white">
                        Version {selectedVersion.versionNumber}
                      </strong>
                      <span className="text-zinc-400"> with </span>
                      <strong className="text-primary">Current Live Version</strong>
                    </div>
                    <Button
                      size="sm"
                      onClick={handleRollback}
                      disabled={isRollingBack}
                      data-testid="restore-version-button"
                      className="gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground h-8 text-xs font-medium"
                    >
                      {isRollingBack ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5" />
                      )}
                      Restore this version
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs flex-1 min-h-0">
                    {/* Historical Version */}
                    <div className="flex flex-col border border-white/10 rounded-lg p-3 bg-black/40 overflow-hidden">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10">
                        <span className="font-semibold text-zinc-300">
                          Version {selectedVersion.versionNumber}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                          {selectedVersion.severity}
                        </span>
                      </div>
                      <pre className="text-zinc-300 font-mono text-[11px] whitespace-pre-wrap overflow-y-auto flex-1">
                        {selectedVersion.description}
                      </pre>
                    </div>

                    {/* Current Version */}
                    <div className="flex flex-col border border-primary/20 rounded-lg p-3 bg-primary/5 overflow-hidden">
                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-primary/20">
                        <span className="font-semibold text-primary">Current Live</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                          {currentSeverity}
                        </span>
                      </div>
                      <pre className="text-zinc-200 font-mono text-[11px] whitespace-pre-wrap overflow-y-auto flex-1">
                        {currentDescription}
                      </pre>
                    </div>
                  </div>

                  {/* Side-by-side / Inline Diff Section */}
                  <div className="border border-white/10 rounded-lg p-3 bg-black/60 text-xs max-h-40 overflow-y-auto">
                    <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <ArrowLeftRight className="w-3.5 h-3.5 text-primary" />
                      Differences
                    </div>
                    {diffLines.length === 0 || diffLines.every((l) => l.type === "unchanged") ? (
                      <div className="text-zinc-500 italic text-xs">No text differences found.</div>
                    ) : (
                      <div className="font-mono text-[11px] space-y-0.5">
                        {diffLines.map((line, idx) => (
                          <div
                            key={idx}
                            className={`px-1.5 py-0.5 rounded ${
                              line.type === "added"
                                ? "bg-emerald-500/20 text-emerald-400"
                                : line.type === "removed"
                                  ? "bg-red-500/20 text-red-400 line-through"
                                  : "text-zinc-500"
                            }`}
                          >
                            <span className="select-none mr-2 font-bold">
                              {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                            </span>
                            {line.content || " "}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
