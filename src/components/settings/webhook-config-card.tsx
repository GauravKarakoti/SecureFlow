"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, GitBranch, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

interface WebhookConfigCardProps {
  /** Base application URL for constructing endpoint webhooks */
  baseUrl?: string;
  defaultProvider?: "gitlab" | "bitbucket";
}

function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="m23.6 9.58-1.02-3.14c-.11-.35-.37-.62-.71-.73-.34-.11-.71-.05-.99.16l-3.32 2.5-3.08-9.48c-.12-.37-.41-.65-.78-.73-.37-.09-.76.02-1.04.28-.27.27-.37.66-.25 1.03l2.25 6.94H9.34l2.25-6.94c.12-.37.02-.76-.25-1.03-.28-.26-.67-.37-1.04-.28-.37.08-.66.36-.78.73L6.44 8.37 3.12 5.87c-.28-.21-.65-.27-.99-.16-.34.11-.6.38-.71.73L.4 9.58c-.16.51.01 1.07.43 1.41l11.02 8.27c.1.08.23.14.36.14s.26-.06.36-.14l11.02-8.27c.42-.34.59-.9.43-1.41z" />
    </svg>
  );
}

function BitbucketIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M2.65 3C2.3 3 2 3.3 2 3.65c0 .05 0 .1.05.15l2.7 16.5c.05.3.3.55.6.55h13.3c.3 0 .55-.25.6-.55l2.7-16.5c.05-.35-.2-.7-.55-.7H2.65zm12.3 12.35H9.05L7.9 8.65h8.2l-1.15 6.7z" />
    </svg>
  );
}

export default function WebhookConfigCard({
  baseUrl,
  defaultProvider = "gitlab",
}: WebhookConfigCardProps) {
  const [activeTab, setActiveTab] = useState<"gitlab" | "bitbucket">(defaultProvider);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Derive origin from window if running client-side without explicit prop
  const currentOrigin =
    baseUrl || (typeof window !== "undefined" ? window.location.origin : "https://app.secureflow.dev");

  const gitlabEndpoint = `${currentOrigin}/api/webhooks/gitlab`;
  const bitbucketEndpoint = `${currentOrigin}/api/webhooks/bitbucket`;

  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedField(label);
      toast.success(`${label} copied to clipboard.`);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast.error("Failed to copy to clipboard.");
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <GitBranch className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <CardTitle>Inbound VCS Webhooks</CardTitle>
              <CardDescription>
                Configure real-time automated PR and push security scanning for GitLab and Bitbucket.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
            Active Handlers
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {/* Provider Switcher */}
        <div className="grid w-full grid-cols-2 p-1 bg-muted rounded-md mb-6 gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "gitlab"}
            onClick={() => setActiveTab("gitlab")}
            className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all gap-2 ${
              activeTab === "gitlab"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <GitLabIcon className="w-4 h-4 text-[#FC6D26]" />
            GitLab CI/CD
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "bitbucket"}
            onClick={() => setActiveTab("bitbucket")}
            className={`inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all gap-2 ${
              activeTab === "bitbucket"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <BitbucketIcon className="w-4 h-4 text-[#0052CC]" />
            Bitbucket Pipelines
          </button>
        </div>

        {/* ── GitLab Configuration ── */}
        {activeTab === "gitlab" && (
          <div className="space-y-5 animate-in fade-in duration-300">
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Webhook Ingestion URL
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    readOnly
                    value={gitlabEndpoint}
                    className="font-mono text-xs bg-black/40 border-white/10"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => copyToClipboard(gitlabEndpoint, "GitLab URL")}
                  >
                    {copiedField === "GitLab URL" ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedField === "GitLab URL" ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-purple-400" /> Secret Token (Header)
                  </label>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    Matches GITLAB_WEBHOOK_TOKEN
                  </span>
                </div>
                <div className="mt-1 flex gap-2">
                  <Input
                    readOnly
                    value="X-Gitlab-Token: <your-configured-gitlab-token>"
                    className="font-mono text-xs bg-black/40 border-white/10 text-muted-foreground"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => copyToClipboard("X-Gitlab-Token", "Header Name")}
                  >
                    {copiedField === "Header Name" ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    Header
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4 space-y-2">
              <h4 className="text-xs font-semibold text-foreground flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" /> Setup Instructions (GitLab)
              </h4>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside leading-relaxed">
                <li>Navigate to your project on GitLab: <strong>Settings &gt; Webhooks</strong>.</li>
                <li>Paste the Ingestion URL into the <strong>URL</strong> field.</li>
                <li>Provide the shared secret in the <strong>Secret token</strong> field.</li>
                <li>Check the <strong>Merge requests events</strong>, <strong>Push events</strong>, and <strong>Pipeline events</strong> triggers.</li>
                <li>Enable <strong>Enable SSL verification</strong> and click <strong>Add webhook</strong>.</li>
              </ol>
            </div>
          </div>
        )}

        {/* ── Bitbucket Configuration ── */}
        {activeTab === "bitbucket" && (
          <div className="space-y-5 animate-in fade-in duration-300">
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Webhook Ingestion URL
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    readOnly
                    value={bitbucketEndpoint}
                    className="font-mono text-xs bg-black/40 border-white/10"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => copyToClipboard(bitbucketEndpoint, "Bitbucket URL")}
                  >
                    {copiedField === "Bitbucket URL" ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedField === "Bitbucket URL" ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-blue-400" /> HMAC Signature Verification
                  </label>
                  <span className="text-[11px] font-mono text-muted-foreground">
                    Matches BITBUCKET_WEBHOOK_SECRET
                  </span>
                </div>
                <div className="mt-1 flex gap-2">
                  <Input
                    readOnly
                    value="X-Hub-Signature: sha256=<calculated-hmac-sha256>"
                    className="font-mono text-xs bg-black/40 border-white/10 text-muted-foreground"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-1.5"
                    onClick={() => copyToClipboard("X-Hub-Signature", "Signature Header")}
                  >
                    {copiedField === "Signature Header" ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    Header
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4 space-y-2">
              <h4 className="text-xs font-semibold text-foreground flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" /> Setup Instructions (Bitbucket)
              </h4>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside leading-relaxed">
                <li>Go to repository settings: <strong>Repository settings &gt; Webhooks</strong>.</li>
                <li>Click <strong>Add webhook</strong> and enter a title (e.g. SecureFlow CI Scan).</li>
                <li>Paste the Bitbucket Ingestion URL above.</li>
                <li>Enter your HMAC shared secret in <strong>Secret</strong> (corresponds to <code className="text-primary font-mono text-[11px]">BITBUCKET_WEBHOOK_SECRET</code>).</li>
                <li>Select triggers under Pull Request (<strong>Created</strong>, <strong>Updated</strong>, <strong>Merged</strong>) and Repository (<strong>Push</strong>).</li>
                <li>Click <strong>Save</strong> to activate automatic pipeline scanning.</li>
              </ol>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
