import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  listWebhookDeliveries,
  getWebhookDeliveryStats,
  getRecentWebhookRepositories,
} from "@/lib/webhooks/delivery-recorder";
import { DeliveriesClient } from "./deliveries-client";
import { Webhook } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function WebhookDeliveriesPage() {
  const session = await auth();
  if (!session?.user || !session.user.roles?.includes("ADMIN")) {
    redirect("/");
  }

  const [deliveriesResult, stats, repositories] = await Promise.all([
    listWebhookDeliveries({ limit: 25, offset: 0 }),
    getWebhookDeliveryStats(7),
    getRecentWebhookRepositories(7),
  ]);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-primary/10 border border-primary/30 flex items-center justify-center">
            <Webhook className="w-4 h-4 text-primary" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">Webhook Deliveries</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Real-time diagnostics and audit trail for received webhook events over the last 7 days.
          Verify delivery arrival, HMAC signature validation, skip reasons, and scan outcomes
          without accessing server logs.
        </p>
      </div>

      <DeliveriesClient
        initialDeliveries={deliveriesResult.deliveries.map((d: any) => ({
          ...d,
          createdAt: typeof d.createdAt === "object" ? d.createdAt.toISOString() : d.createdAt,
        }))}
        initialTotal={deliveriesResult.total}
        initialStats={stats}
        initialRepositories={repositories}
      />
    </div>
  );
}
