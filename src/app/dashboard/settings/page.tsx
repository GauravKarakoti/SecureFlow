import SettingsClient from "./settings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getSlackWebhook, getTeamsWebhook, getVoiceAlerts } from "@/lib/actions/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const [initialWebhookUrl, initialTeamsWebhookUrl, initialVoiceAlertsEnabled] = await Promise.all([
    getSlackWebhook(),
    getTeamsWebhook(),
    getVoiceAlerts(),
  ]);

  return (
    <SettingsClient
      initialWebhookUrl={initialWebhookUrl}
      initialTeamsWebhookUrl={initialTeamsWebhookUrl}
      initialVoiceAlertsEnabled={initialVoiceAlertsEnabled}
    />
  );
}
