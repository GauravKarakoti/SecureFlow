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
  updateRepositoryPublicBadge,
  updateWeeklyDigestPreference,
  type RepoBadgeSetting,
} from "@/lib/actions/settings";
import { Save, MessageSquare, Volume2, Send, Shield, Copy, Mail } from "lucide-react";
import WebhookConfigCard from "@/components/settings/webhook-config-card";

export default function SettingsClient({
  initialWebhookUrl,
  initialTeamsWebhookUrl,
  initialVoiceAlertsEnabled,
  initialRepositories = [],
  initialWeeklyDigestEnabled = true,
}: {
  initialWebhookUrl: string | null;
  initialTeamsWebhookUrl?: string | null;
  initialVoiceAlertsEnabled: boolean;
  initialRepositories?: RepoBadgeSetting[];
  initialWeeklyDigestEnabled?: boolean;
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

  // --- Weekly Security Digest state ---
  const [weeklyDigestEnabled, setWeeklyDigestEnabled] = useState(initialWeeklyDigestEnabled);
  const [isDigestPending, startDigestTransition] = useTransition();

  // --- Status badges state ---
  const [repositories, setRepositories] = useState<RepoBadgeSetting[]>(initialRepositories);
  const [isBadgePending, startBadgeTransition] = useTransition();

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

  const handleDigestToggle = (checked: boolean) => {
    setWeeklyDigestEnabled(checked);
    startDigestTransition(async () => {
      try {
        const res = await updateWeeklyDigestPreference(checked);
        if (res.success) {
          toast.success(
            checked ? "Weekly security digest enabled." : "Weekly security digest disabled.",
          );
        } else {
          setWeeklyDigestEnabled(!checked);
          toast.error("Failed to update weekly digest preference.");
        }
      } catch (e: unknown) {
        setWeeklyDigestEnabled(!checked);
        toast.error(e instanceof Error ? e.message : "Failed to update weekly digest preference.");
      }
    });
  };

  const handleBadgeToggle = (repoId: string, checked: boolean) => {
    setRepositories((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, publicBadgeEnabled: checked } : r)),
    );
    startBadgeTransition(async () => {
      try {
        const res = await updateRepositoryPublicBadge(repoId, checked);
        if (res.success) {
          toast.success(checked ? "Public status badge enabled." : "Public status badge disabled.");
        } else {
          setRepositories((prev) =>
            prev.map((r) => (r.id === repoId ? { ...r, publicBadgeEnabled: !checked } : r)),
          );
          toast.error(res.error || "Failed to update badge setting.");
        }
      } catch (e: unknown) {
        setRepositories((prev) =>
          prev.map((r) => (r.id === repoId ? { ...r, publicBadgeEnabled: !checked } : r)),
        );
        toast.error(e instanceof Error ? e.message : "Failed to update badge setting.");
      }
    });
  };

  const handleCopyMarkdown = (markdown: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(markdown);
      toast.success("Badge Markdown copied to clipboard!");
    }
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

      {/* ── Weekly Security Digest ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <Mail className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <CardTitle>Weekly Security Digest</CardTitle>
              <CardDescription>
                Receive an automated weekly security briefing highlighting new and resolved
                vulnerabilities, repeat finding types, and blocked PRs across your repositories.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable Weekly Email Digest</p>
              <p className="text-xs text-muted-foreground">
                Delivered once a week per user. For your privacy and security, raw code snippets and
                sensitive secrets are never included.
              </p>
            </div>
            <Switch
              checked={weeklyDigestEnabled}
              onCheckedChange={handleDigestToggle}
              disabled={isDigestPending}
              aria-label="Enable weekly security digest"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Repository Status Badges ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500/10 rounded-lg">
              <Shield className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <CardTitle>Repository Status Badges</CardTitle>
              <CardDescription>
                Share your repository&apos;s real-time security posture in your README. Private
                repos remain protected — repositories with public badges disabled return a neutral
                &quot;unknown&quot; badge without revealing scan status.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {repositories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories connected yet. Sync your repositories from the overview dashboard to
              enable status badges.
            </p>
          ) : (
            repositories.map((repo) => {
              const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
              const badgeUrl = `${appUrl}/api/badge/${repo.fullName}`;
              const markdown = `[![SecureFlow Status](${badgeUrl})](${appUrl || "/"})`;
              return (
                <div
                  key={repo.id}
                  className="flex flex-col gap-3 rounded-lg border border-border p-4 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-sm">{repo.fullName}</p>
                      <p className="text-xs text-muted-foreground">
                        {repo.publicBadgeEnabled
                          ? "Public badge enabled — shows latest scan status"
                          : "Public badge disabled — returns neutral unknown badge"}
                      </p>
                    </div>
                    <Switch
                      checked={repo.publicBadgeEnabled}
                      onCheckedChange={(checked) => handleBadgeToggle(repo.id, checked)}
                      disabled={isBadgePending}
                      aria-label={`Toggle public badge for ${repo.fullName}`}
                    />
                  </div>

                  {repo.publicBadgeEnabled && (
                    <div className="mt-2 space-y-3 rounded-md bg-muted/40 p-3">
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-medium text-muted-foreground">Preview:</span>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={badgeUrl} alt={`${repo.fullName} badge`} className="h-5" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          readOnly
                          value={markdown}
                          className="font-mono text-xs bg-background/50 h-8"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1.5 shrink-0"
                          onClick={() => handleCopyMarkdown(markdown)}
                        >
                          <Copy className="w-3.5 h-3.5" />
                          Copy Markdown
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
