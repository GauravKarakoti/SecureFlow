import SettingsClient from "./settings-client";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getSlackWebhook } from "@/lib/actions/settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const initialWebhookUrl = await getSlackWebhook();

  return <SettingsClient initialWebhookUrl={initialWebhookUrl} />;
}
