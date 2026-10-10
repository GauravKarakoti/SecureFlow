import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getAiHealthReport } from "@/ai/telemetry";
import AiHealthClient from "./ai-health-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "AI Model & Circuit Breaker Health | SecureFlow",
  description: "Real-time telemetry, sliding-window latency, and circuit breaker resilience monitoring for AI models.",
};

export default async function AiHealthDashboardPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const isAdmin = Boolean(session.user.roles?.includes("ADMIN"));
  const initialData = await getAiHealthReport();

  return <AiHealthClient initialData={initialData} isAdmin={isAdmin} />;
}
