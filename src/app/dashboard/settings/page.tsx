import SettingsClient from "./settings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  getSlackWebhook,
  getTeamsWebhook,
  getVoiceAlerts,
  getUserRepositoriesWithBadgeStatus,
  getWeeklyDigestPreference,
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
    initialWeeklyDigestEnabled,
  ] = await Promise.all([
    getSlackWebhook(),
    getTeamsWebhook(),
    getVoiceAlerts(),
    getUserRepositoriesWithBadgeStatus(),
    getWeeklyDigestPreference(),
  ]);

  return (
    <SettingsClient
      initialWebhookUrl={initialWebhookUrl}
      initialTeamsWebhookUrl={initialTeamsWebhookUrl}
      initialVoiceAlertsEnabled={initialVoiceAlertsEnabled}
      initialRepositories={initialRepositories}
      initialWeeklyDigestEnabled={initialWeeklyDigestEnabled}
    />
  );
}
