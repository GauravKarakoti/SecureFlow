"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Play, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { severityBadge } from "@/lib/severity";

interface PolicyOption {
  id: string;
  name: string;
  description: string;
}

interface TestFinding {
  type: string;
  severity: string;
  description: string;
  explanation?: string;
  fileLocation: string;
  lineStart?: number;
  lineEnd?: number;
}

export function TestPolicyPanel({ policies = [] }: { policies?: PolicyOption[] }) {
  const [selectedPolicyId, setSelectedPolicyId] = useState<string>(policies[0]?.id || "custom");
  const [customDescription, setCustomDescription] = useState<string>(policies[0]?.description || "");
  const [snippet, setSnippet] = useState<string>("");
  const [filename, setFilename] = useState<string>("example.ts");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [tested, setTested] = useState<boolean>(false);
  const [findings, setFindings] = useState<TestFinding[]>([]);

  const handlePolicyChange = (id: string) => {
    setSelectedPolicyId(id);
    if (id === "custom") {
      setCustomDescription("");
    } else {
      const match = policies.find((p) => p.id === id);
      if (match) {
        setCustomDescription(match.description);
      }
    }
  };

  const handleRunTest = async () => {
    if (!customDescription.trim()) {
      toast.error("Please provide or select a policy description to test.");
      return;
    }
    if (!snippet.trim()) {
      toast.error("Please paste a code snippet to test against.");
      return;
    }

    setIsLoading(true);
    setTested(false);
    setFindings([]);

    try {
      const res = await fetch("/api/policies/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policyDescription: customDescription.trim(),
          snippet: snippet.trim(),
          filename: filename.trim() || "example.ts",
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to test policy");
        return;
      }

      setFindings(data.findings || []);
      setTested(true);
      if ((data.findings || []).length > 0) {
        toast.warning(`Matched ${data.findings.length} finding(s) with policy.`);
      } else {
        toast.success("No violations found. Policy passed clean against snippet.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error running policy test");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="glass-card border-primary/30 bg-primary/5">
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-primary" />
          <CardTitle className="text-xl">Test Policy (Playground)</CardTitle>
        </div>
        <CardDescription>
          Paste a sample code snippet to verify whether your policy matches vulnerabilities or causes false positives before deploying it. Runs in-memory without saving anything or posting to GitHub.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {policies.length > 0 && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Select Policy or Template</label>
            <select
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              value={selectedPolicyId}
              onChange={(e) => handlePolicyChange(e.target.value)}
              aria-label="Select policy to test"
            >
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="custom">✍️ Custom Policy Phrasing...</option>
            </select>
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">Policy Rule / Description to Test</label>
          <Input
            placeholder="e.g. Flag hardcoded AWS access keys or unescaped HTML interpolation"
            value={customDescription}
            onChange={(e) => setCustomDescription(e.target.value)}
            disabled={isLoading}
            aria-label="Policy rule description"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="md:col-span-3 space-y-2">
            <label className="text-sm font-medium">Sample Code Snippet</label>
            <Textarea
              placeholder="// Paste sample code here to test policy match..."
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              rows={6}
              disabled={isLoading}
              className="font-mono text-xs"
              aria-label="Code snippet"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Target Filename</label>
            <Input
              placeholder="example.ts"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              disabled={isLoading}
              className="font-mono text-xs"
              aria-label="Target filename"
            />
            <p className="text-xs text-muted-foreground">
              Useful if testing rules scoped by file type (e.g. <code>.env</code> or <code>.sql</code>).
            </p>
          </div>
        </div>

        <div className="flex justify-between items-center pt-2">
          <Button
            onClick={handleRunTest}
            disabled={isLoading || !customDescription.trim() || !snippet.trim()}
            className="gap-2"
          >
            <Play className="w-4 h-4" />
            {isLoading ? "Running Test Scanner..." : "Test Policy"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Isolated in-memory scan • Zero database writes
          </span>
        </div>

        {/* Results Area */}
        {tested && (
          <div className="mt-4 pt-4 border-t border-border space-y-3">
            <h4 className="text-sm font-semibold tracking-tight">Test Results</h4>
            {findings.length === 0 ? (
              <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
                <div className="text-sm text-green-300">
                  <p className="font-medium">No findings detected</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    The snippet passed this policy cleanly without generating any security findings.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <div
                    key={i}
                    className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 space-y-1 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-destructive" />
                      <span className="font-semibold">{severityBadge(f.severity as any)}</span>
                      <span className="font-medium text-foreground">{f.type}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        in {f.fileLocation}
                        {f.lineStart ? `:${f.lineStart}` : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground pt-1">{f.explanation || f.description}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
