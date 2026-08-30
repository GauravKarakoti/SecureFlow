import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getScanJobs } from "@/lib/actions/scan-jobs";
import QueueClient from "./queue-client";

export const dynamic = "force-dynamic";

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const params = await searchParams;
  const status = (params.status as string) || "all";
  const result = await getScanJobs(session.user.id, status);

  return <QueueClient jobs={result.jobs} stats={result.stats} currentStatus={status} />;
}
