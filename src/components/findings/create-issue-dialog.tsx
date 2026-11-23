"use client";

import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink, GitPullRequest, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { getFindingIssuePrefill, createIssueForFinding } from "@/lib/actions/finding-issues";

interface CreateIssueDialogProps {
  findingId: string;
  existingIssueUrl?: string | null;
  triggerButton?: React.ReactNode;
  onIssueCreated?: (url: string) => void;
  className?: string;
  variant?: "table" | "detail";
}

export default function CreateIssueDialog({
  findingId,
  existingIssueUrl,
  triggerButton,
  onIssueCreated,
  className = "",
  variant = "table",
}: CreateIssueDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [currentIssueUrl, setCurrentIssueUrl] = useState<string | null>(existingIssueUrl ?? null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isLoadingPrefill, setIsLoadingPrefill] = useState(false);
  const [prefillLoaded, setPrefillLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCreating, startCreateTransition] = useTransition();

  const handleOpenChange = async (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && !prefillLoaded && !currentIssueUrl) {
      setIsLoadingPrefill(true);
      setErrorMessage(null);
      try {
        const res = await getFindingIssuePrefill(findingId);
        if (res.ok) {
          if (res.alreadyCreated && res.issueUrl) {
            setCurrentIssueUrl(res.issueUrl);
          } else if (res.prefill) {
            setTitle(res.prefill.title);
            setBody(res.prefill.body);
            setPrefillLoaded(true);
          }
        } else {
          setErrorMessage(res.error || "Failed to load issue template");
        }
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to load issue template");
      } finally {
        setIsLoadingPrefill(false);
      }
    }
  };

  const handleConfirmCreate = () => {
    setErrorMessage(null);
    startCreateTransition(async () => {
      try {
        const res = await createIssueForFinding(findingId, {
          title,
          body,
        });

        if (res.ok && res.issueUrl) {
          setCurrentIssueUrl(res.issueUrl);
          onIssueCreated?.(res.issueUrl);
          toast({
            title: "Issue Created",
            description: `Successfully created GitHub issue #${res.issueNumber}`,
          });
          setOpen(false);
        } else {
          setErrorMessage(res.error || "Failed to create issue");
          toast({
            title: "Failed to Create Issue",
            description: res.error || "Could not create GitHub issue",
            variant: "destructive",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Error creating issue";
        setErrorMessage(msg);
        toast({
          title: "Error",
          description: msg,
          variant: "destructive",
        });
      }
    });
  };

  // If an issue is already linked, render the link directly
  if (currentIssueUrl) {
    const issueNum = currentIssueUrl.split("/").pop();
    return (
      <a
        href={currentIssueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1.5 font-mono text-xs text-purple-400 hover:text-purple-300 bg-purple-500/10 border border-purple-500/20 px-2.5 py-1 rounded-md hover:bg-purple-500/20 transition-colors shrink-0 ${className}`}
        title={`Linked GitHub Issue: ${currentIssueUrl}`}
        data-testid="finding-issue-link"
        onClick={(e) => e.stopPropagation()}
      >
        <GitPullRequest className="w-3.5 h-3.5 text-purple-400" />
        <span>Issue #{issueNum}</span>
        <ExternalLink className="w-3 h-3 ml-0.5 opacity-70" />
      </a>
    );
  }

  const buttonClass =
    variant === "detail"
      ? `gap-1.5 font-mono text-xs border-purple-500/30 text-purple-300 hover:bg-purple-500/10 w-full sm:w-auto ${className}`
      : `gap-1.5 font-mono text-xs border-purple-500/30 text-purple-300 hover:bg-purple-500/10 ${className}`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild onClick={(e) => e.stopPropagation()}>
        {triggerButton || (
          <Button
            size="sm"
            variant="outline"
            className={buttonClass}
            data-testid="create-issue-button"
          >
            <GitPullRequest className="w-3.5 h-3.5" />
            <span>Create Issue</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="max-w-2xl bg-zinc-950 border-white/10 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <GitPullRequest className="w-5 h-5 text-purple-400" />
            Create GitHub Issue
          </DialogTitle>
          <DialogDescription className="text-zinc-400 text-xs">
            Create a tracking issue in the repository for this security finding. Sensitive secrets
            and raw code snippets are automatically redacted.
          </DialogDescription>
        </DialogHeader>

        {isLoadingPrefill ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-zinc-400 text-sm">
            <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
            <span>Generating sanitized issue template...</span>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {errorMessage && (
              <div
                className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start gap-2"
                data-testid="create-issue-error"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{errorMessage}</span>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">Issue Title</label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Issue Title"
                className="bg-white/5 border-white/10 text-sm font-mono text-zinc-200"
                disabled={isCreating}
                data-testid="issue-title-input"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-zinc-300">
                Issue Description (Markdown)
              </label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className="bg-white/5 border-white/10 text-xs font-mono text-zinc-200 resize-y leading-relaxed"
                disabled={isCreating}
                data-testid="issue-body-textarea"
              />
            </div>

            <div className="p-3 rounded-lg bg-purple-500/5 border border-purple-500/20 text-purple-300 text-[11px] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-purple-400" />
              <span>
                Secrets and raw diff snippets are stripped to prevent credential leaks in issue
                trackers.
              </span>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={isCreating}
            className="text-zinc-400"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleConfirmCreate}
            disabled={isCreating || isLoadingPrefill || !title.trim()}
            className="bg-purple-600 hover:bg-purple-500 text-white gap-2 font-mono text-xs"
            data-testid="confirm-create-issue-button"
          >
            {isCreating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>{isCreating ? "Creating Issue..." : "Create GitHub Issue"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
