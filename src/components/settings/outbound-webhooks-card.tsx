"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  createOutboundWebhook,
  deleteOutboundWebhook,
  toggleOutboundWebhook,
  getOutboundWebhookDeliveries,
  testOutboundWebhook,
  type OutboundWebhookView,
  type OutboundWebhookDeliveryView,
} from "@/lib/actions/settings";
import { OUTBOUND_EVENT_TYPES, type OutboundEventType } from "@/lib/webhooks/outbound-dispatcher";
import {
  Webhook,
  Plus,
  Trash2,
  Send,
  History,
  Check,
  Copy,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ExternalLink,
} from "lucide-react";

const EVENT_DESCRIPTIONS: Record<OutboundEventType, string> = {
  "scan.completed": "Triggered when a scan finishes",
  "scan.blocked": "Triggered when a scan is blocked by policy",
  "finding.created": "Triggered when new findings are detected",
  "finding.dismissed": "Triggered when a finding is dismissed in triage",
};

export default function OutboundWebhooksCard({
  initialWebhooks = [],
}: {
  initialWebhooks?: OutboundWebhookView[];
}) {
  const [webhooks, setWebhooks] = useState<OutboundWebhookView[]>(initialWebhooks);
  const [isPending, startTransition] = useTransition();

  // Create form state
  const [isCreating, setIsCreating] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [selectedEvents, setSelectedEvents] = useState<OutboundEventType[]>([
    "scan.completed",
    "scan.blocked",
  ]);

  // One-time secret display state
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Delivery log modal state
  const [viewingWebhookId, setViewingWebhookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<OutboundWebhookDeliveryView[]>([]);
  const [isLoadingDeliveries, setIsLoadingDeliveries] = useState(false);

  const toggleEventSelection = (event: OutboundEventType) => {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  };

  const handleCreateWebhook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim()) {
      toast.error("Please enter a webhook URL.");
      return;
    }
    if (selectedEvents.length === 0) {
      toast.error("Please select at least one event.");
      return;
    }

    startTransition(async () => {
      try {
        const res = await createOutboundWebhook({
          url: newUrl.trim(),
          events: selectedEvents,
          description: newDescription.trim() || undefined,
        });

        if (res.success && res.webhook) {
          toast.success("Outbound webhook registered successfully.");
          setCreatedSecret(res.webhook.secret);
          setWebhooks((prev) => [
            {
              id: res.webhook!.id,
              url: res.webhook!.url,
              events: res.webhook!.events,
              description: res.webhook!.description,
              enabled: true,
              createdAt: new Date(),
              updatedAt: new Date(),
              latestDelivery: null,
            },
            ...prev,
          ]);
          setNewUrl("");
          setNewDescription("");
          setIsCreating(false);
        } else {
          toast.error(res.error || "Failed to create webhook.");
        }
      } catch (err: any) {
        toast.error(err?.message || "An unexpected error occurred.");
      }
    });
  };

  const handleToggle = (id: string, currentEnabled: boolean) => {
    const next = !currentEnabled;
    startTransition(async () => {
      try {
        const res = await toggleOutboundWebhook(id, next);
        if (res.success) {
          setWebhooks((prev) =>
            prev.map((w) => (w.id === id ? { ...w, enabled: next } : w)),
          );
          toast.success(next ? "Webhook enabled." : "Webhook disabled.");
        } else {
          toast.error(res.error || "Failed to update webhook.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to update webhook.");
      }
    });
  };

  const handleDelete = (id: string) => {
    if (!window.confirm("Are you sure you want to delete this outbound webhook endpoint?")) return;

    startTransition(async () => {
      try {
        const res = await deleteOutboundWebhook(id);
        if (res.success) {
          setWebhooks((prev) => prev.filter((w) => w.id !== id));
          toast.success("Webhook endpoint deleted.");
        } else {
          toast.error(res.error || "Failed to delete webhook.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to delete webhook.");
      }
    });
  };

  const handleTestPing = (id: string) => {
    startTransition(async () => {
      try {
        toast.info("Sending test ping to endpoint...");
        const res = await testOutboundWebhook(id);
        if (res.success) {
          toast.success(`Test ping succeeded (HTTP ${res.statusCode}).`);
        } else {
          toast.error(`Test ping failed: ${res.error || `HTTP ${res.statusCode}`}`);
        }
      } catch (err: any) {
        toast.error(`Test ping failed: ${err?.message || "Unknown error"}`);
      }
    });
  };

  const handleOpenDeliveries = async (webhookId: string) => {
    setViewingWebhookId(webhookId);
    setIsLoadingDeliveries(true);
    try {
      const logs = await getOutboundWebhookDeliveries(webhookId, 20);
      setDeliveries(logs);
    } catch {
      toast.error("Failed to fetch delivery logs.");
    } finally {
      setIsLoadingDeliveries(false);
    }
  };

  const copySecretToClipboard = () => {
    if (!createdSecret) return;
    navigator.clipboard.writeText(createdSecret);
    setSecretCopied(true);
    toast.success("Secret copied to clipboard.");
    setTimeout(() => setSecretCopied(false), 3000);
  };

  return (
    <Card className="border border-border bg-card">
      <CardHeader className="flex flex-row items-center justify-between pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Webhook className="h-5 w-5 text-primary" />
            <CardTitle className="text-xl">Outbound Webhooks</CardTitle>
          </div>
          <CardDescription>
            Stream scan and finding events to external systems (SIEM, ticketing, bots) signed with HMAC-SHA256.
          </CardDescription>
        </div>
        {!isCreating && (
          <Button
            size="sm"
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-1.5"
          >
            <Plus className="h-4 w-4" />
            Add Webhook
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Secret Created One-Time Notice */}
        {createdSecret && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 space-y-2">
            <div className="flex items-center gap-2 text-yellow-500 font-semibold text-sm">
              <AlertTriangle className="h-4 w-4" />
              Webhook Signing Secret (Shown Once)
            </div>
            <p className="text-xs text-muted-foreground">
              Verify signatures via the <code className="bg-muted px-1 py-0.5 rounded">X-SecureFlow-Signature</code> header.
              Copy this secret now; it will not be displayed again.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={createdSecret}
                className="font-mono text-xs bg-background"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={copySecretToClipboard}
                className="shrink-0"
              >
                {secretCopied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                {secretCopied ? "Copied" : "Copy"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setCreatedSecret(null)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* Create Webhook Form */}
        {isCreating && (
          <form
            onSubmit={handleCreateWebhook}
            className="rounded-lg border border-border/80 bg-muted/30 p-4 space-y-4"
          >
            <div className="space-y-1">
              <h4 className="text-sm font-semibold">Register HTTPS Webhook Endpoint</h4>
              <p className="text-xs text-muted-foreground">
                Destination must use HTTPS. Private, loopback, and link-local addresses are rejected.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Endpoint URL</label>
              <Input
                placeholder="https://api.example.com/webhooks/secureflow"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                required
                className="bg-background"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Description (Optional)</label>
              <Input
                placeholder="e.g. Jira Ticket Integration, Splunk SIEM"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="bg-background"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium">Subscribed Events</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {OUTBOUND_EVENT_TYPES.map((event) => {
                  const checked = selectedEvents.includes(event);
                  return (
                    <label
                      key={event}
                      className="flex items-start gap-2.5 rounded-md border border-border/60 bg-background/50 p-2 cursor-pointer hover:bg-muted/40 transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleEventSelection(event)}
                        className="mt-0.5 rounded border-muted-foreground"
                      />
                      <div className="space-y-0.5">
                        <div className="font-mono text-xs font-semibold">{event}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {EVENT_DESCRIPTIONS[event]}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsCreating(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Registering..." : "Save Endpoint"}
              </Button>
            </div>
          </form>
        )}

        {/* Webhooks List */}
        {webhooks.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground border border-dashed rounded-lg">
            No outbound webhooks configured. Register an HTTPS endpoint to stream scan and finding events to your external tools.
          </div>
        ) : (
          <div className="space-y-3">
            {webhooks.map((hook) => (
              <div
                key={hook.id}
                className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 rounded-lg border border-border bg-card/60 hover:bg-card transition-colors"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-medium text-foreground break-all">
                      {hook.url}
                    </span>
                    {hook.description && (
                      <span className="text-xs text-muted-foreground">({hook.description})</span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
                    {hook.events.map((evt) => (
                      <Badge key={evt} variant="secondary" className="text-[10px] py-0 px-1.5">
                        {evt}
                      </Badge>
                    ))}
                  </div>

                  {hook.latestDelivery && (
                    <div className="text-[11px] flex items-center gap-1.5 text-muted-foreground pt-0.5">
                      {hook.latestDelivery.statusCode && hook.latestDelivery.statusCode >= 200 && hook.latestDelivery.statusCode < 300 ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-red-500" />
                      )}
                      <span>
                        Last delivery: HTTP {hook.latestDelivery.statusCode ?? "ERR"} ({hook.latestDelivery.attempts}{" "}
                        {hook.latestDelivery.attempts === 1 ? "attempt" : "attempts"})
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                  <Switch
                    checked={hook.enabled}
                    onCheckedChange={() => handleToggle(hook.id, hook.enabled)}
                    disabled={isPending}
                    aria-label={`Toggle webhook ${hook.url}`}
                  />

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleTestPing(hook.id)}
                    disabled={isPending}
                    title="Send Test Ping"
                  >
                    <Send className="h-3.5 w-3.5 mr-1" />
                    Test
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleOpenDeliveries(hook.id)}
                    title="View Delivery Logs"
                  >
                    <History className="h-3.5 w-3.5 mr-1" />
                    Logs
                  </Button>

                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(hook.id)}
                    disabled={isPending}
                    className="text-destructive hover:text-destructive"
                    title="Delete Webhook"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Deliveries Modal / Drawer */}
        {viewingWebhookId && (
          <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-primary" />
                <h4 className="text-sm font-semibold">Recent Delivery Logs</h4>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setViewingWebhookId(null)}
              >
                Close
              </Button>
            </div>

            {isLoadingDeliveries ? (
              <div className="py-4 text-center text-xs text-muted-foreground">Loading delivery history...</div>
            ) : deliveries.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">No delivery logs recorded yet.</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {deliveries.map((d) => (
                  <div
                    key={d.id}
                    className="p-2.5 rounded border border-border/70 bg-background text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium">{d.event}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(d.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span
                        className={
                          d.statusCode && d.statusCode >= 200 && d.statusCode < 300
                            ? "text-green-500 font-semibold"
                            : "text-red-500 font-semibold"
                        }
                      >
                        HTTP {d.statusCode ?? "ERROR"}
                      </span>
                      <span>•</span>
                      <span>{d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}</span>
                      {d.error && (
                        <>
                          <span>•</span>
                          <span className="text-red-400 truncate max-w-xs">{d.error}</span>
                        </>
                      )}
                    </div>
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
