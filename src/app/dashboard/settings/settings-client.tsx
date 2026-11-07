"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  updateSlackWebhook,
  updateTeamsWebhook,
  updateVoiceAlerts,
  testSlackWebhook,
  testTeamsWebhook,
} from "@/lib/actions/settings";
import { Save, MessageSquare, Volume2, Send } from "lucide-react";
import WebhookConfigCard from "@/components/settings/webhook-config-card";

export default function SettingsClient({
  initialWebhookUrl,
  initialTeamsWebhookUrl,
  initialVoiceAlertsEnabled,
}: {
  initialWebhookUrl: string | null;
  initialTeamsWebhookUrl?: string | null;
  initialVoiceAlertsEnabled: boolean;
}) {
  // --- Slack state ---
  const [webhookUrl, setWebhookUrl] = useState(initialWebhookUrl || "");
  const [isPending, startTransition] = useTransition();
  const [isSlackTesting, startSlackTest] = useTransition();

  // --- Teams state ---
  const [teamsWebhookUrl, setTeamsWebhookUrl] = useState(initialTeamsWebhookUrl || "");
  const [isTeamsPending, startTeamsTransition] = useTransition();
  const [isTeamsTesting, startTeamsTest] = useTransition();

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

  const handleTestSlack = () => {
    if (!webhookUrl || !webhookUrl.trim()) {
      toast.error("Enter a Slack webhook URL first to test.");
      return;
    }
    startSlackTest(async () => {
      try {
        const res = await testSlackWebhook(webhookUrl);
        if (res.success) {
          toast.success("Slack test notification sent successfully!");
        } else {
          toast.error(res.error || "Failed to deliver Slack test notification.");
        }
      } catch (e: any) {
        toast.error(e.message || "Failed to send Slack test notification.");
      }
    });
  };

  const handleSaveTeams = () => {
    startTeamsTransition(async () => {
      try {
        await updateTeamsWebhook(teamsWebhookUrl);
        toast.success("Teams settings saved successfully.");
      } catch (e: any) {
        toast.error(e.message || "Failed to save Teams settings.");
      }
    });
  };

  const handleTestTeams = () => {
    if (!teamsWebhookUrl || !teamsWebhookUrl.trim()) {
      toast.error("Enter a Microsoft Teams webhook URL first to test.");
      return;
    }
    startTeamsTest(async () => {
      try {
        const res = await testTeamsWebhook(teamsWebhookUrl);
        if (res.success) {
          toast.success("Microsoft Teams test notification sent successfully!");
        } else {
          toast.error(res.error || "Failed to deliver Teams test notification.");
        }
      } catch (e: any) {
        toast.error(e.message || "Failed to send Teams test notification.");
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
                Receive real-time alerts for CRITICAL and HIGH severity findings or BLOCKED scans.
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

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={isPending} className="gap-2">
              <Save className="w-4 h-4" />
              {isPending ? "Saving..." : "Save Settings"}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestSlack}
              disabled={isSlackTesting || !webhookUrl}
              className="gap-2"
            >
              <Send className="w-4 h-4" />
              {isSlackTesting ? "Testing..." : "Test Webhook"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Microsoft Teams Integration ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <MessageSquare className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <CardTitle>Microsoft Teams Integration</CardTitle>
              <CardDescription>
                Receive real-time notifications when a security scan ends as BLOCKED.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-200">Incoming Webhook URL</label>
            <Input
              type="url"
              placeholder="https://outlook.office.com/webhook/..."
              value={teamsWebhookUrl}
              onChange={(e) => setTeamsWebhookUrl(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Leave this blank to disable Microsoft Teams notifications.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSaveTeams} disabled={isTeamsPending} className="gap-2">
              <Save className="w-4 h-4" />
              {isTeamsPending ? "Saving..." : "Save Teams Settings"}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestTeams}
              disabled={isTeamsTesting || !teamsWebhookUrl}
              className="gap-2"
            >
              <Send className="w-4 h-4" />
              {isTeamsTesting ? "Testing..." : "Test Teams Webhook"}
            </Button>
          </div>
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
