"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updateSlackWebhook, updateVoiceAlerts } from "@/lib/actions/settings";
import { Save, MessageSquare, Volume2 } from "lucide-react";
import WebhookConfigCard from "@/components/settings/webhook-config-card";

export default function SettingsClient({
  initialWebhookUrl,
  initialVoiceAlertsEnabled,
}: {
  initialWebhookUrl: string | null;
  initialVoiceAlertsEnabled: boolean;
}) {
  // --- Slack state ---
  const [webhookUrl, setWebhookUrl] = useState(initialWebhookUrl || "");
  const [isPending, startTransition] = useTransition();

  // --- Voice alerts state ---
  const [voiceAlertsEnabled, setVoiceAlertsEnabled] = useState(initialVoiceAlertsEnabled);
  const [isVoicePending, startVoiceTransition] = useTransition();

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateSlackWebhook(webhookUrl);
        toast.success("Settings saved successfully.");
      } catch (e: any) {
        toast.error(e.message || "Failed to save settings.");
      }
    });
  };

  const handleVoiceToggle = (checked: boolean) => {
    setVoiceAlertsEnabled(checked);
    startVoiceTransition(async () => {
      try {
        await updateVoiceAlerts(checked);
        toast.success(
          checked
            ? "Voice alerts enabled. You will hear audio alerts for critical findings."
            : "Voice alerts disabled.",
        );
      } catch (e: any) {
        // Roll back optimistic update on failure
        setVoiceAlertsEnabled(!checked);
        toast.error(e.message || "Failed to update voice alert preference.");
      }
    });
  };

  return (
    <div className="space-y-8 w-full animate-in fade-in duration-700 max-w-4xl">
      <div>
        <span className="text-sm font-medium uppercase tracking-widest text-primary">
          Configuration
        </span>
        <h1 className="mt-1 font-headline text-4xl font-extrabold tracking-tight">
          Integrations & Settings
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Manage your integrations, configure inbound CI/CD webhooks, and external alerts.
        </p>
      </div>

      {/* ── Inbound VCS Webhook Configuration (GitLab & Bitbucket) ── */}
      <WebhookConfigCard />

      {/* ── Slack Integration ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <MessageSquare className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <CardTitle>Slack Integration</CardTitle>
              <CardDescription>
                Receive real-time alerts for CRITICAL and HIGH severity findings.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-200">Incoming Webhook URL</label>
            <Input
              type="url"
              placeholder="https://hooks.slack.com/services/..."
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Leave this blank to disable Slack notifications.
            </p>
          </div>

          <Button onClick={handleSave} disabled={isPending} className="gap-2">
            <Save className="w-4 h-4" />
            {isPending ? "Saving..." : "Save Settings"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Voice Alerts ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-500/10 rounded-lg">
              <Volume2 className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <CardTitle>Voice Alerts</CardTitle>
              <CardDescription>
                Hear spoken audio alerts when CRITICAL or HIGH severity findings are detected or a
                deployment is blocked. Disabled by default — opt in to enable.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable Voice Alerts</p>
              <p className="text-xs text-muted-foreground">
                Uses ElevenLabs text-to-speech to announce security alerts in your browser while the
                dashboard is open. Your browser must allow audio playback.
              </p>
            </div>
            <Switch
              checked={voiceAlertsEnabled}
              onCheckedChange={handleVoiceToggle}
              disabled={isVoicePending}
              aria-label="Enable voice alerts"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
