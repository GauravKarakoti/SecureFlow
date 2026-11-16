"use client";

import { useState, useRef } from "react";
import {
  Download,
  Upload,
  CheckCircle2,
  AlertTriangle,
  FileJson,
  Loader2,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { PolicyImportPreview } from "@/lib/policies/export-import";

export function PolicyExportImport() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isExporting, setIsExporting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [filePayload, setFilePayload] = useState<unknown>(null);
  const [preview, setPreview] = useState<PolicyImportPreview | null>(null);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const res = await fetch("/api/policies/export");
      if (!res.ok) {
        throw new Error("Failed to export policies");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `secureflow-policies-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success("Policies exported successfully");
    } catch (err: any) {
      toast.error(err?.message || "Failed to export policies");
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) {
      toast.error("Policy file exceeds maximum allowed size (1 MB)");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsUploading(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("The selected file is not valid JSON");
      }

      setFilePayload(parsed);

      const previewRes = await fetch("/api/policies/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });

      const previewData = await previewRes.json();
      if (!previewRes.ok) {
        throw new Error(
          previewData.message || previewData.error || "Failed to validate policy file",
        );
      }

      setPreview(previewData);
      setDialogOpen(true);
    } catch (err: any) {
      toast.error(err?.message || "Invalid policy file");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleApplyImport = async () => {
    if (!filePayload) return;

    setIsApplying(true);
    try {
      const res = await fetch("/api/policies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(filePayload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || data.error || "Failed to apply policy import");
      }

      toast.success(
        `Successfully applied ${data.total} policies (${data.createdCount} created, ${data.updatedCount} updated)`,
      );
      setDialogOpen(false);
      router.refresh();
    } catch (err: any) {
      toast.error(err?.message || "Failed to import policies");
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".json,application/json"
          className="hidden"
          data-testid="policy-file-input"
        />

        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={isExporting}
          data-testid="export-policies-button"
          className="gap-2 border-white/10 hover:bg-white/5"
        >
          {isExporting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          data-testid="import-policies-button"
          className="gap-2 border-white/10 hover:bg-white/5"
        >
          {isUploading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          Import
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl bg-zinc-950 border border-white/10 text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              <FileJson className="w-5 h-5 text-primary" />
              Preview Policy Import
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Review the policies detected in the import file before applying them to your
              workspace.
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-4 my-2">
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 bg-white/5 rounded-lg border border-white/10 text-center">
                  <div className="text-xl font-bold text-white">{preview.totalInFile}</div>
                  <div className="text-xs text-zinc-400">Total in File</div>
                </div>
                <div className="p-3 bg-emerald-500/10 rounded-lg border border-emerald-500/20 text-center">
                  <div className="text-xl font-bold text-emerald-400">{preview.toCreate}</div>
                  <div className="text-xs text-emerald-500/80">To Create</div>
                </div>
                <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20 text-center">
                  <div className="text-xl font-bold text-amber-400">{preview.toUpdate}</div>
                  <div className="text-xs text-amber-500/80">To Update</div>
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto space-y-2 border border-white/10 rounded-lg p-2 bg-black/40">
                {preview.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 rounded bg-white/5 border border-white/5 text-sm"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="font-medium text-white truncate">{item.name}</div>
                      <div className="text-xs text-zinc-400 truncate">{item.description}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                        {item.severity}
                      </span>
                      {item.status === "create" && (
                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-medium">
                          Create
                        </span>
                      )}
                      {item.status === "update" && (
                        <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 font-medium">
                          Update
                        </span>
                      )}
                      {item.status === "unchanged" && (
                        <span className="text-xs px-2 py-0.5 rounded bg-zinc-700/50 text-zinc-400">
                          Unchanged
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="ghost"
              onClick={() => setDialogOpen(false)}
              disabled={isApplying}
              className="hover:bg-white/10 text-zinc-400 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              onClick={handleApplyImport}
              disabled={isApplying || !preview || preview.items.length === 0}
              data-testid="confirm-apply-import-button"
              className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isApplying ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Applying...
                </>
              ) : (
                <>
                  Apply Policies
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
