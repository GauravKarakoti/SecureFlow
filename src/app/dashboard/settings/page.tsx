import SettingsClient from "./settings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  getSlackWebhook,
  getTeamsWebhook,
  getVoiceAlerts,
  getUserRepositoriesWithBadgeStatus,
  getApiTokens,
} from "@/lib/actions/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const [
    initialWebhookUrl,
    initialTeamsWebhookUrl,
    initialVoiceAlertsEnabled,
    initialRepositories,
    initialApiTokens,
  ] = await Promise.all([
    getSlackWebhook(),
    getTeamsWebhook(),
    getVoiceAlerts(),
    getUserRepositoriesWithBadgeStatus(),
    getApiTokens(),
  ]);

  return (
    <SettingsClient
      initialWebhookUrl={initialWebhookUrl}
      initialTeamsWebhookUrl={initialTeamsWebhookUrl}
      initialVoiceAlertsEnabled={initialVoiceAlertsEnabled}
      initialRepositories={initialRepositories}
      initialApiTokens={initialApiTokens}
    />
  );
}
