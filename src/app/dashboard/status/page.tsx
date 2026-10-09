import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { runHealthCheck } from "@/lib/health-check";
import StatusClient from "./status-client";

export const dynamic = "force-dynamic";

export default async function StatusPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const report = await runHealthCheck();

  return (
    <StatusClient
      status={report.status}
      timestamp={report.timestamp}
      uptime={report.uptime}
      components={report.components}
    />
  );
}
