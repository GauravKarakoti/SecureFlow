"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { PatchDiffViewer } from "@/components/findings/patch-diff-viewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, AlertTriangle, GitPullRequest } from "lucide-react";
import { toast } from "sonner";

export default function RemediationPage() {
  const params = useParams();
  const findingId = params.id as string;

  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [pullRequestUrl, setPullRequestUrl] = useState<string | null>(null);
  const [patchData, setPatchData] = useState<{ patchDiff: string; explanation: string } | null>(
    null,
  );

  const generatePatch = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/findings/${findingId}/remediate`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to generate patch");

      const data = await res.json();
      setPatchData({ patchDiff: data.patch.patchDiff, explanation: data.explanation });
      toast.success("Remediation patch generated successfully");
    } catch (error) {
      toast.error("Failed to generate remediation patch");
    } finally {
      setLoading(false);
    }
  };

  const approveAndOpenPullRequest = async () => {
    if (!window.confirm("Approve this patch and create a draft pull request?")) return;

    setApproving(true);
    try {
      const response = await fetch(`/api/findings/${findingId}/remediate/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to create pull request");

      setPullRequestUrl(data.pullRequest);
      toast.success("Approved fix committed and draft pull request opened");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create pull request");
    } finally {
      setApproving(false);
    }
  };

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-6 h-6 text-orange-500" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Remediation</h1>
      </div>

      {!patchData ? (
        <Card className="bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800">
          <CardContent className="py-12 text-center space-y-4">
            <p className="text-gray-600 dark:text-gray-400">
              Click the button below to let The Professor analyze the finding and generate a secure
              code patch.
            </p>
            <Button onClick={generatePatch} disabled={loading} size="lg">
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {loading ? "Analyzing..." : "Generate Remediation Patch"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <PatchDiffViewer patchDiff={patchData.patchDiff} explanation={patchData.explanation} />
          {pullRequestUrl ? (
            <a
              className="inline-flex items-center gap-2 text-sm font-medium text-primary underline"
              href={pullRequestUrl}
              target="_blank"
              rel="noreferrer"
            >
              <GitPullRequest className="h-4 w-4" aria-hidden="true" />
              Open draft pull request
            </a>
          ) : (
            <Button onClick={approveAndOpenPullRequest} disabled={approving}>
              {approving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <GitPullRequest className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {approving ? "Creating draft PR..." : "Approve & create draft PR"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
