import SettingsClient from "./settings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  getChatWebhookStatus,
  getSlackWebhook,
  getTeamsWebhook,
  getVoiceAlerts,
  getUserRepositoriesWithBadgeStatus,
  getApiTokens,
  getOutboundWebhooks,
  getWeeklyDigestPreference,
  getNotificationPreferences,
} from "@/lib/actions/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const [
    chatWebhookStatus,
    initialWebhookUrl,
    initialTeamsWebhookUrl,
    initialVoiceAlertsEnabled,
    initialRepositories,
    initialApiTokens,
    initialOutboundWebhooks,
    initialWeeklyDigestEnabled,
    initialNotificationPreferences,
  ] = await Promise.all([
    getChatWebhookStatus(),
    getSlackWebhook(),
    getTeamsWebhook(),
    getVoiceAlerts(),
    getUserRepositoriesWithBadgeStatus(),
    getApiTokens(),
    getOutboundWebhooks(),
    getWeeklyDigestPreference(),
    getNotificationPreferences(),
  ]);

  return (
    <SettingsClient
      initialChatWebhookStatus={chatWebhookStatus}
      initialWebhookUrl={initialWebhookUrl}
      initialTeamsWebhookUrl={initialTeamsWebhookUrl}
      initialVoiceAlertsEnabled={initialVoiceAlertsEnabled}
      initialRepositories={initialRepositories}
      initialApiTokens={initialApiTokens}
      initialOutboundWebhooks={initialOutboundWebhooks}
      initialWeeklyDigestEnabled={initialWeeklyDigestEnabled}
      initialNotificationPreferences={initialNotificationPreferences}
    />
  );
}
