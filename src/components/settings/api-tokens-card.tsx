"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Key,
  Plus,
  Copy,
  Check,
  AlertTriangle,
  Clock,
  Shield,
  Trash2,
  Terminal,
} from "lucide-react";
import { createApiToken, revokeApiToken, type ApiTokenItem } from "@/lib/actions/settings";
import { API_TOKEN_SCOPES, type ApiTokenScope } from "@/lib/auth/api-token-types";

const SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
  "findings:read": "Read security findings, triage status, and code locations",
  "findings:write": "Update triage statuses, dismissals, and apply remediation patches",
  "scans:read": "View pull request scan results and background scan job status",
  "scans:write": "Trigger vulnerability scans via CLI or CI/CD pipelines",
  "policies:read": "View policy templates and export security policy configurations",
  "policies:write": "Import, modify, and test repository security policies",
  "audit:read": "Read tamper-evident audit logs and compliance event ledgers",
};

interface ApiTokensCardProps {
  initialTokens?: ApiTokenItem[];
}

export default function ApiTokensCard({ initialTokens = [] }: ApiTokensCardProps) {
  const [tokens, setTokens] = useState<ApiTokenItem[]>(initialTokens);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreating, startCreateTransition] = useTransition();
  const [isRevoking, startRevokeTransition] = useTransition();

  // Form state
  const [name, setName] = useState("");
  const [expiryChoice, setExpiryChoice] = useState<"30" | "90" | "custom">("30");
  const [customExpiry, setCustomExpiry] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiTokenScope[]>([
    "scans:write",
    "findings:read",
  ]);

  // One-time newly generated token state
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const handleScopeToggle = (scope: ApiTokenScope) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleCreate = () => {
    if (!name.trim()) {
      toast.error("Please enter a name for the API token.");
      return;
    }
    if (selectedScopes.length === 0) {
      toast.error("Please select at least one scope.");
      return;
    }

    let expiresInDays: number | null = null;
    let customExpiresAt: string | null = null;

    if (expiryChoice === "30") expiresInDays = 30;
    else if (expiryChoice === "90") expiresInDays = 90;
    else if (expiryChoice === "custom") {
      if (!customExpiry) {
        toast.error("Please choose a custom expiry date.");
        return;
      }
      customExpiresAt = new Date(customExpiry).toISOString();
    }

    startCreateTransition(async () => {
      try {
        const result = await createApiToken({
          name: name.trim(),
          scopes: selectedScopes,
          expiresInDays,
          customExpiresAt,
        });

        if (!result.success || !result.token) {
          toast.error(result.error || "Failed to create API token.");
          return;
        }

        if (result.tokenItem) {
          setTokens((prev) => [result.tokenItem!, ...prev]);
        }

        setNewlyCreatedToken(result.token);
        toast.success("API token created successfully!");
        setIsDialogOpen(false);
        // Reset form
        setName("");
        setExpiryChoice("30");
        setCustomExpiry("");
        setSelectedScopes(["scans:write", "findings:read"]);
      } catch (err: any) {
        toast.error(err.message || "An unexpected error occurred.");
      }
    });
  };

  const handleRevoke = (tokenId: string, tokenName: string) => {
    if (
      !confirm(
        `Are you sure you want to revoke "${tokenName}"? Any automation or CLI using this token will stop working immediately.`,
      )
    ) {
      return;
    }

    startRevokeTransition(async () => {
      try {
        const result = await revokeApiToken(tokenId);
        if (!result.success) {
          toast.error(result.error || "Failed to revoke token.");
          return;
        }

        setTokens((prev) =>
          prev.map((t) => (t.id === tokenId ? { ...t, revokedAt: new Date().toISOString() } : t)),
        );
        toast.success(`Token "${tokenName}" revoked successfully.`);
      } catch (err: any) {
        toast.error(err.message || "Failed to revoke token.");
      }
    });
  };

  const handleCopyNewToken = async () => {
    if (!newlyCreatedToken) return;
    try {
      await navigator.clipboard.writeText(newlyCreatedToken);
      setCopiedToken(true);
      toast.success("Token copied to clipboard!");
      setTimeout(() => setCopiedToken(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard.");
    }
  };

  return (
    <Card className="border-border">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-xl flex items-center gap-2">
              <Key className="w-5 h-5 text-primary" />
              Personal API Tokens
            </CardTitle>
            <CardDescription>
              Create and manage scoped API tokens for automated workflows, CI/CD pipelines, and the
              SecureFlow CLI.
            </CardDescription>
          </div>

          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-2 shrink-0">
                <Plus className="w-4 h-4" />
                Generate New Token
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Generate Personal API Token</DialogTitle>
                <DialogDescription>
                  Configure name, expiry, and granular permission scopes for this token.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-2">
                <div className="space-y-2">
                  <Label htmlFor="token-name">Token Name</Label>
                  <Input
                    id="token-name"
                    placeholder="e.g. GitHub Actions CI or CLI Laptop"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Expiration</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      type="button"
                      variant={expiryChoice === "30" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setExpiryChoice("30")}
                    >
                      30 Days
                    </Button>
                    <Button
                      type="button"
                      variant={expiryChoice === "90" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setExpiryChoice("90")}
                    >
                      90 Days
                    </Button>
                    <Button
                      type="button"
                      variant={expiryChoice === "custom" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setExpiryChoice("custom")}
                    >
                      Custom Date
                    </Button>
                  </div>
                  {expiryChoice === "custom" && (
                    <div className="pt-2">
                      <Input
                        type="date"
                        value={customExpiry}
                        onChange={(e) => setCustomExpiry(e.target.value)}
                        min={new Date().toISOString().split("T")[0]}
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-3 pt-2">
                  <Label>Select Scopes</Label>
                  <div className="space-y-2 border rounded-md p-3 max-h-56 overflow-y-auto">
                    {API_TOKEN_SCOPES.map((scope) => {
                      const isChecked = selectedScopes.includes(scope);
                      return (
                        <div
                          key={scope}
                          className="flex items-start gap-3 p-1.5 hover:bg-muted/40 rounded transition-colors"
                        >
                          <Checkbox
                            id={`scope-${scope}`}
                            checked={isChecked}
                            onCheckedChange={() => handleScopeToggle(scope)}
                            className="mt-1"
                          />
                          <div className="space-y-0.5">
                            <label
                              htmlFor={`scope-${scope}`}
                              className="text-xs font-mono font-semibold cursor-pointer text-foreground"
                            >
                              {scope}
                            </label>
                            <p className="text-xs text-muted-foreground">
                              {SCOPE_DESCRIPTIONS[scope]}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setIsDialogOpen(false)}
                  disabled={isCreating}
                >
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={isCreating}>
                  {isCreating ? "Generating..." : "Create Token"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* One-time Newly Created Token Callout */}
        {newlyCreatedToken && (
          <Alert className="border-amber-500/50 bg-amber-500/10 text-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <AlertTitle className="text-amber-300 font-semibold flex items-center justify-between">
              <span>Save your new token</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-amber-300 hover:text-white"
                onClick={() => setNewlyCreatedToken(null)}
              >
                Dismiss
              </Button>
            </AlertTitle>
            <AlertDescription className="space-y-3 pt-2 text-xs">
              <p>
                Make sure to copy your personal API token now.{" "}
                <strong>You will not be able to see it again!</strong>
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={newlyCreatedToken}
                  className="font-mono text-xs bg-background/80 border-amber-500/30 text-foreground"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1.5 shrink-0"
                  onClick={handleCopyNewToken}
                >
                  {copiedToken ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      Copy Token
                    </>
                  )}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* Tokens List */}
        {tokens.length === 0 ? (
          <div className="text-center py-8 border border-dashed rounded-lg space-y-3">
            <Key className="w-8 h-8 text-muted-foreground mx-auto" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No personal API tokens yet</p>
              <p className="text-xs text-muted-foreground">
                Generate a token to authenticate the CLI or integrate SecureFlow into your
                pipelines.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border border rounded-lg overflow-hidden">
            {tokens.map((token) => {
              const isRevoked = token.revokedAt !== null;
              const isExpired = token.expiresAt !== null && new Date(token.expiresAt) < new Date();
              const isActive = !isRevoked && !isExpired;

              return (
                <div key={token.id} className="p-4 space-y-3 hover:bg-muted/20 transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-foreground">{token.name}</span>
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                        {token.tokenPrefix}...
                      </code>
                      {isActive && (
                        <Badge
                          variant="outline"
                          className="text-xs border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                        >
                          Active
                        </Badge>
                      )}
                      {isRevoked && (
                        <Badge
                          variant="outline"
                          className="text-xs border-destructive/40 text-destructive bg-destructive/10"
                        >
                          Revoked
                        </Badge>
                      )}
                      {!isRevoked && isExpired && (
                        <Badge
                          variant="outline"
                          className="text-xs border-amber-500/40 text-amber-400 bg-amber-500/10"
                        >
                          Expired
                        </Badge>
                      )}
                    </div>

                    {isActive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5 self-start sm:self-auto"
                        onClick={() => handleRevoke(token.id, token.name)}
                        disabled={isRevoking}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Revoke
                      </Button>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {token.scopes.map((scope) => (
                      <Badge
                        key={scope}
                        variant="secondary"
                        className="text-[11px] font-mono font-normal"
                      >
                        {scope}
                      </Badge>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-y-1 gap-x-4 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {token.expiresAt ? (
                        <span>
                          {isExpired ? "Expired on " : "Expires "}
                          {new Date(token.expiresAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span>No expiration</span>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      <Terminal className="w-3.5 h-3.5" />
                      {token.lastUsedAt ? (
                        <span>
                          Last used {new Date(token.lastUsedAt).toLocaleDateString()}
                          {token.lastUsedIp ? ` from ${token.lastUsedIp}` : ""}
                        </span>
                      ) : (
                        <span>Never used</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
