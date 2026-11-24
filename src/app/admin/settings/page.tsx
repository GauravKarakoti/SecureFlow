import { auth } from "@/auth";
import { getInstallationSettings } from "@/lib/actions/installation-settings";
import InstallationSettingsClient from "./settings-client";

export const metadata = {
  title: "Installation Baseline Settings · SecureFlow Admin",
  description:
    "Configure installation-wide default gate severity, confidence thresholds, and skip rules.",
};

export default async function AdminSettingsPage() {
  await auth();
  const settings = await getInstallationSettings("default");

  return <InstallationSettingsClient initialSettings={settings} />;
}
