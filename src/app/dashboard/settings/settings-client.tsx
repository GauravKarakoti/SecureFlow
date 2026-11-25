"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  updateChatWebhook,
  getChatWebhookStatus,
  testChatWebhook,
  type ChatWebhookStatus,
  updateSlackWebhook,
  updateTeamsWebhook,
  updateVoiceAlerts,
  testSlackWebhook,
  testTeamsWebhook,
  updateRepositoryPublicBadge,
  updateRepositoryCodeScanning,
  updateWeeklyDigestPreference,
  updateNotificationPreferences,
  type RepoBadgeSetting,
  type ApiTokenItem,
  type NotificationPreferencesDto,
} from "@/lib/actions/settings";
import {
  Save,
  MessageSquare,
  Volume2,
  Send,
  Shield,
  ShieldAlert,
  AlertTriangle,
  Copy,
  Mail,
  Bell,
  Play,
  RotateCw,
  Calendar,
  Lock,
  Sliders,
} from "lucide-react";
import {
  updateRepositoryBaselineConfig,
  triggerRepositoryBaselineScan,
} from "@/lib/actions/baseline";
import WebhookConfigCard from "@/components/settings/webhook-config-card";
import ApiTokensCard from "@/components/settings/api-tokens-card";
import OutboundWebhooksCard from "@/components/settings/outbound-webhooks-card";
import { type OutboundWebhookView } from "@/lib/actions/settings";

const subscribeToOrigin = () => () => {};
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => "";

function SettingSourceBadge({ source, isLocked }: { source: string; isLocked?: boolean }) {
  const label =
    source === "repository"
      ? "Repository (.secureflow.json)"
      : source === "installation"
        ? "Installation Default"
        : "Built-in Default";
  const badgeClass =
    source === "repository"
      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
      : source === "installation"
        ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
        : "bg-muted text-muted-foreground border-border";

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Badge variant="outline" className={`text-[10px] font-mono font-medium ${badgeClass}`}>
        {label}
      </Badge>
      {isLocked && (
        <Badge
          variant="outline"
          className="text-[10px] font-mono font-medium bg-amber-500/10 text-amber-400 border-amber-500/30 flex items-center gap-1"
        >
          <Lock className="w-2.5 h-2.5" />
          Locked Baseline
        </Badge>
      )}
    </div>
  );
}

export default function SettingsClient({
  initialChatWebhookStatus,
  initialWebhookUrl,
  initialTeamsWebhookUrl,
  initialVoiceAlertsEnabled,
  initialRepositories = [],
  initialApiTokens = [],
  initialOutboundWebhooks = [],
  initialWeeklyDigestEnabled = true,
  initialNotificationPreferences = {
    notifyOnAssignment: true,
    notifyOnMention: true,
    notifyOnDismissalExpiry: true,
  },
}: {
  initialChatWebhookStatus?: ChatWebhookStatus;
  initialWebhookUrl: string | null;
  initialTeamsWebhookUrl?: string | null;
  initialVoiceAlertsEnabled: boolean;
  initialRepositories?: RepoBadgeSetting[];
  initialApiTokens?: ApiTokenItem[];
  initialOutboundWebhooks?: OutboundWebhookView[];
  initialWeeklyDigestEnabled?: boolean;
  initialNotificationPreferences?: NotificationPreferencesDto;
}) {
  // --- In-app notification preferences state (#1979) ---
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferencesDto>(
    initialNotificationPreferences,
  );
  const [isNotifPending, startNotifTransition] = useTransition();

  const handleNotifPrefToggle = (key: keyof NotificationPreferencesDto, checked: boolean) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: checked }));
    startNotifTransition(async () => {
      try {
        const res = await updateNotificationPreferences({ [key]: checked });
        if (res.ok) {
          toast.success("Notification preferences updated.");
        } else {
          toast.error(res.error || "Failed to update notification preferences.");
          setNotifPrefs((prev) => ({ ...prev, [key]: !checked }));
        }
      } catch (e: any) {
        toast.error(e.message || "Failed to update notification preferences.");
        setNotifPrefs((prev) => ({ ...prev, [key]: !checked }));
      }
    });
  };

  // --- Slack & Discord Chat Alerts state ---
  const [isSaved, setIsSaved] = useState(Boolean(initialWebhookUrl));
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
  const appOrigin = useSyncExternalStore(subscribeToOrigin, getBrowserOrigin, getServerOrigin);

  const handleSave = () => {
    startTransition(async () => {
      try {
        await updateSlackWebhook(webhookUrl);
        setIsSaved(true);
        setWebhookUrl("");
        toast.success("Settings saved successfully.");
      } catch (e: any) {
        toast.error(e.message || "Failed to save settings.");
      }
    });
  };

  const handleTestSlack = () => {
    if (!webhookUrl && !isSaved) {
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

  const handleCodeScanningToggle = (repoId: string, checked: boolean) => {
    setRepositories((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, codeScanningEnabled: checked } : r)),
    );
    startBadgeTransition(async () => {
      try {
        const res = await updateRepositoryCodeScanning(repoId, checked);
        if (res.success) {
          toast.success(
            checked
              ? "Code scanning publishing enabled for repository."
              : "Code scanning publishing disabled for repository.",
          );
        } else {
          setRepositories((prev) =>
            prev.map((r) => (r.id === repoId ? { ...r, codeScanningEnabled: !checked } : r)),
          );
          toast.error(res.error || "Failed to update code scanning setting.");
        }
      } catch (e: any) {
        setRepositories((prev) =>
          prev.map((r) => (r.id === repoId ? { ...r, codeScanningEnabled: !checked } : r)),
        );
        toast.error(e.message || "Failed to update code scanning setting.");
      }
    });
  };

  // --- Baseline Scans state & handlers (#2011) ---
  const [isBaselinePending, startBaselineTransition] = useTransition();

  const handleBaselineToggle = (repoId: string, enabled: boolean) => {
    setRepositories((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, baselineScanEnabled: enabled } : r)),
    );
    startBaselineTransition(async () => {
      try {
        const res = await updateRepositoryBaselineConfig(repoId, { enabled });
        if (res.ok) {
          toast.success(
            enabled
              ? "Scheduled baseline scanning enabled."
              : "Scheduled baseline scanning disabled.",
          );
        } else {
          setRepositories((prev) =>
            prev.map((r) => (r.id === repoId ? { ...r, baselineScanEnabled: !enabled } : r)),
          );
          toast.error(res.error || "Failed to update baseline scan settings.");
        }
      } catch (err: any) {
        setRepositories((prev) =>
          prev.map((r) => (r.id === repoId ? { ...r, baselineScanEnabled: !enabled } : r)),
        );
        toast.error(err?.message || "Failed to update baseline scan settings.");
      }
    });
  };

  const handleBaselineFrequencyChange = (repoId: string, frequency: string) => {
    setRepositories((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, baselineFrequency: frequency } : r)),
    );
    startBaselineTransition(async () => {
      try {
        const res = await updateRepositoryBaselineConfig(repoId, { frequency });
        if (res.ok) {
          toast.success(`Baseline frequency updated to ${frequency}.`);
        } else {
          toast.error(res.error || "Failed to update baseline frequency.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to update baseline frequency.");
      }
    });
  };

  const handleBaselineFileLimitChange = (repoId: string, limit: number) => {
    setRepositories((prev) =>
      prev.map((r) => (r.id === repoId ? { ...r, baselineFileLimit: limit } : r)),
    );
    startBaselineTransition(async () => {
      try {
        const res = await updateRepositoryBaselineConfig(repoId, { fileLimit: limit });
        if (res.ok) {
          toast.success(`Baseline file limit set to ${limit} files.`);
        } else {
          toast.error(res.error || "Failed to update baseline file limit.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to update baseline file limit.");
      }
    });
  };

  const handleRunBaselineNow = (repoId: string) => {
    startBaselineTransition(async () => {
      try {
        toast.info("Starting baseline scan of default branch...");
        const res = await triggerRepositoryBaselineScan(repoId, { force: true });
        if (res.ok) {
          toast.success(
            "Baseline scan complete! Findings are tagged and available in the Baseline tab.",
          );
          setRepositories((prev) =>
            prev.map((r) =>
              r.id === repoId
                ? {
                    ...r,
                    lastBaselineScanAt: new Date(),
                    lastBaselineScanStatus: "COMPLETED",
                  }
                : r,
            ),
          );
        } else {
          toast.error(res.error || "Failed to execute baseline scan.");
        }
      } catch (err: any) {
        toast.error(err?.message || "Failed to execute baseline scan.");
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

      {/* ── Chat Alerts Integration (Slack & Discord) ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <MessageSquare className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <CardTitle>Chat Alerts (Slack & Discord)</CardTitle>
                <CardDescription>
                  Receive real-time alerts for newly introduced CRITICAL security findings in your Slack or Discord channels.
                </CardDescription>
              </div>
            </div>
            {isSaved && (
              <Badge
                variant="outline"
                className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10"
              >
                Webhook Configured
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-200">
              Incoming Webhook URL (Slack or Discord)
            </label>
            <Input
              type="text"
              placeholder="https://hooks.slack.com/services/..."
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              className="font-mono text-sm"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {isSaved ? (
                <span className="text-emerald-400/90 font-medium">
                  ✓ Webhook URL is stored securely encrypted. Enter a new URL above to update.
                </span>
              ) : (
                "Paste your Slack Incoming Webhook or Discord Webhook URL. Stored securely encrypted at rest."
              )}
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={handleSave} disabled={isPending} className="gap-2">
              <Save className="w-4 h-4" />
              {isPending ? "Saving..." : "Save Settings"}
            </Button>
            <Button
              variant="outline"
              onClick={handleTestSlack}
              disabled={isSlackTesting}
              className="gap-2"
            >
              <Send className="w-4 h-4" />
              {isSlackTesting ? "Sending..." : "Send Test Message / Test Webhook"}
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

      {/* ── Outbound Webhooks ── */}
      <OutboundWebhooksCard initialWebhooks={initialOutboundWebhooks} />

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

      {/* ── In-App Notifications Preferences (#1979) ── */}
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <Bell className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <CardTitle>In-App Notifications</CardTitle>
              <CardDescription>
                Choose which activities trigger notifications in your dashboard header and
                notification center.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Finding Assignments</p>
              <p className="text-xs text-muted-foreground">
                Notify me when a security finding is assigned to me.
              </p>
            </div>
            <Switch
              checked={notifPrefs.notifyOnAssignment}
              onCheckedChange={(checked) => handleNotifPrefToggle("notifyOnAssignment", checked)}
              disabled={isNotifPending}
              aria-label="Notify on finding assignments"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Reviewer Note @Mentions</p>
              <p className="text-xs text-muted-foreground">
                Notify me when someone mentions me (@username) in a reviewer note.
              </p>
            </div>
            <Switch
              checked={notifPrefs.notifyOnMention}
              onCheckedChange={(checked) => handleNotifPrefToggle("notifyOnMention", checked)}
              disabled={isNotifPending}
              aria-label="Notify on reviewer note mentions"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Dismissal Expirations</p>
              <p className="text-xs text-muted-foreground">
                Notify me when a finding dismissal I created is approaching its expiration date.
              </p>
            </div>
            <Switch
              checked={notifPrefs.notifyOnDismissalExpiry}
              onCheckedChange={(checked) =>
                handleNotifPrefToggle("notifyOnDismissalExpiry", checked)
              }
              disabled={isNotifPending}
              aria-label="Notify on dismissal expirations"
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
                Share your repository&apos;s real-time security posture in your README, and publish
                scan results to GitHub Code Scanning (Security tab).
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
              const badgePath = `/api/badge/${repo.fullName.split("/").map(encodeURIComponent).join("/")}`;
              const badgeUrl = `${appOrigin}${badgePath}`;
              const markdown = `[![SecureFlow Status](${badgeUrl})](${appOrigin || "/"})`;

              return (
                <div
                  key={repo.id}
                  className="flex flex-col gap-4 rounded-lg border border-border p-4 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-sm">{repo.fullName}</p>
                  </div>

                  {/* Code Scanning */}
                  <div className="flex items-center justify-between border-t border-border/40 pt-3">
                    <div>
                      <p className="text-sm font-medium">
                        Publish findings to GitHub Code Scanning
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {repo.codeScanningEnabled
                          ? "Publishing enabled — scan findings are uploaded to GitHub's Security tab (SARIF)"
                          : "Publishing disabled — scan findings stay in SecureFlow"}
                      </p>
                    </div>
                    <Switch
                      checked={repo.codeScanningEnabled}
                      onCheckedChange={(checked) => handleCodeScanningToggle(repo.id, checked)}
                      disabled={isBadgePending}
                      aria-label={`Toggle code scanning for ${repo.fullName}`}
                    />
                  </div>

                  {repo.codeScanningEnabled && repo.codeScanningWarning && (
                    <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 p-3 text-amber-200 text-xs">
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">
                          Missing GitHub Permissions or Advanced Security
                        </p>
                        <p className="text-amber-300/80 mt-0.5">{repo.codeScanningWarning}</p>
                      </div>
                    </div>
                  )}

                  {/* Public Badge */}
                  <div className="flex items-center justify-between border-t border-border/40 pt-3">
                    <div>
                      <p className="text-sm font-medium">Public Status Badge</p>
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

                  {/* Scheduled Baseline Security Scan (#2011) */}
                  <div className="flex flex-col gap-3 border-t border-border/40 pt-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">Scheduled Baseline Security Scans</p>
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-purple-500/10 text-purple-400 border-purple-500/30"
                          >
                            BASELINE
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Scan the default branch in bounded chunks for pre-existing
                          vulnerabilities, secrets, and misconfigurations without blocking pull
                          requests.
                        </p>
                      </div>
                      <Switch
                        checked={repo.baselineScanEnabled ?? false}
                        onCheckedChange={(checked) => handleBaselineToggle(repo.id, checked)}
                        disabled={isBaselinePending}
                        aria-label={`Toggle baseline scans for ${repo.fullName}`}
                      />
                    </div>

                    {repo.baselineScanEnabled && (
                      <div className="rounded-md bg-muted/30 border border-border/50 p-3 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              Scan Frequency
                            </label>
                            <select
                              value={repo.baselineFrequency ?? "weekly"}
                              onChange={(e) =>
                                handleBaselineFrequencyChange(repo.id, e.target.value)
                              }
                              disabled={isBaselinePending}
                              aria-label={`Baseline frequency for ${repo.fullName}`}
                              className="w-full text-xs bg-background border border-border rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                            >
                              <option value="weekly">Weekly (Recommended)</option>
                              <option value="daily">Daily</option>
                              <option value="monthly">Monthly</option>
                            </select>
                          </div>

                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              File Limit (1 - 200)
                            </label>
                            <Input
                              type="number"
                              min={1}
                              max={200}
                              value={repo.baselineFileLimit ?? 50}
                              onChange={(e) =>
                                handleBaselineFileLimitChange(
                                  repo.id,
                                  parseInt(e.target.value, 10) || 50,
                                )
                              }
                              disabled={isBaselinePending}
                              aria-label={`Baseline file limit for ${repo.fullName}`}
                              className="h-8 text-xs font-mono"
                            />
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-border/40 pt-2 text-xs">
                          <div className="text-muted-foreground flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-primary" />
                            <span>
                              {repo.lastBaselineScanAt
                                ? `Last scanned: ${new Date(repo.lastBaselineScanAt).toLocaleDateString()}`
                                : "Never scanned"}
                            </span>
                            {repo.lastBaselineScanStatus && (
                              <Badge variant="outline" className="text-[10px] py-0 px-1">
                                {repo.lastBaselineScanStatus}
                              </Badge>
                            )}
                          </div>

                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRunBaselineNow(repo.id)}
                            disabled={isBaselinePending}
                            className="h-7 text-xs gap-1.5 self-start sm:self-auto"
                            aria-label={`Run baseline scan now for ${repo.fullName}`}
                          >
                            <Play className="w-3 h-3 text-purple-400" />
                            {isBaselinePending ? "Scanning..." : "Run Baseline Scan Now"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
        
                  {/* Effective Security & Governance Baseline Settings (#2010) */}
                  {repo.effectiveSettings && (
                    <div className="border-t border-border/40 pt-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Sliders className="w-4 h-4 text-primary" />
                          <p className="text-sm font-medium">
                            Effective Security &amp; Gate Settings
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          Hierarchical resolution with locked baseline enforcement
                        </span>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {/* Gate Block On */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Gate Block Severity
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.gateBlockOn.source}
                              isLocked={repo.effectiveSettings.gateBlockOn.isLocked}
                            />
                          </div>
                          <div className="font-mono text-sm font-semibold">
                            {repo.effectiveSettings.gateBlockOn.value}
                          </div>
                        </div>

                        {/* Gate Review On */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Gate Review Severity
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.gateReviewOn.source}
                              isLocked={repo.effectiveSettings.gateReviewOn.isLocked}
                            />
                          </div>
                          <div className="font-mono text-sm font-semibold">
                            {repo.effectiveSettings.gateReviewOn.value}
                          </div>
                        </div>

                        {/* Min Comment Confidence */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Confidence Threshold
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.minCommentConfidence.source}
                              isLocked={repo.effectiveSettings.minCommentConfidence.isLocked}
                            />
                          </div>
                          <div className="font-mono text-sm font-semibold">
                            {repo.effectiveSettings.minCommentConfidence.value}
                          </div>
                        </div>

                        {/* Include Defaults */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Default Rules
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.includeDefaults.source}
                              isLocked={repo.effectiveSettings.includeDefaults.isLocked}
                            />
                          </div>
                          <div className="font-mono text-sm font-semibold">
                            {repo.effectiveSettings.includeDefaults.value ? "Included" : "Excluded"}
                          </div>
                        </div>

                        {/* Skip Drafts */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Skip Draft PRs
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.skipDrafts.source}
                              isLocked={repo.effectiveSettings.skipDrafts.isLocked}
                            />
                          </div>
                          <div className="font-mono text-sm font-semibold">
                            {repo.effectiveSettings.skipDrafts.value ? "Enabled" : "Disabled"}
                          </div>
                        </div>

                        {/* Skip Authors */}
                        <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium text-muted-foreground">
                              Skip Authors
                            </span>
                            <SettingSourceBadge
                              source={repo.effectiveSettings.skipAuthors.source}
                              isLocked={repo.effectiveSettings.skipAuthors.isLocked}
                            />
                          </div>
                          <div
                            className="font-mono text-xs font-semibold truncate"
                            title={repo.effectiveSettings.skipAuthors.value.join(", ") || "None"}
                          >
                            {repo.effectiveSettings.skipAuthors.value.length > 0
                              ? repo.effectiveSettings.skipAuthors.value.join(", ")
                              : "None"}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Personal API Tokens (#1867) */}
      <ApiTokensCard initialTokens={initialApiTokens} />
    </div>
  );
}
