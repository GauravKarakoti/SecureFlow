import { Card, CardContent } from "@/components/ui/card";
import { Shield, Activity } from "lucide-react";
import prisma from "@/lib/prisma";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  getUserAuditLogs,
  getUserAuditLogFilters,
  type UserAuditLogRow,
} from "@/lib/actions/audit";
import AuditLogTable from "./audit-log-table";

export default async function AuditPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/api/auth/signin");
  }

  const userId = session.user.id;

  const [initialResult, filters, activeReposCount, actions24hCount] =
    await Promise.all([
      getUserAuditLogs({ page: 1, pageSize: 10 }),
      getUserAuditLogFilters(),
      prisma.repository.count({ where: { userId, isActive: true } }),
      prisma.auditLog.count({
        where: {
          userId,
          timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

  // Every log returned is already scoped to this user (or is a null-userId
  // "System" event), so there's no need to look up multiple users here —
  // just resolve the signed-in user's own display name once.
  const ownName = session.user.name || session.user.email || "You";
  const displayUser = (log: UserAuditLogRow) => (log.userId ? ownName : "System");

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="font-headline text-3xl font-bold tracking-tight mb-2">Audit Logs</h1>
          <p className="text-muted-foreground">Comprehensive trail of all security decisions and system actions.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Monitored Repos</div>
            <div className="text-lg font-bold">{activeReposCount} Active</div>
          </div>
        </div>

        <div className="bg-foreground/[0.03] rounded-xl border border-foreground/10 p-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">System Actions</div>
            <div className="text-lg font-bold">{actions24hCount.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <Card className="glass-card">
        <CardContent className="p-4">
          <AuditLogTable
            initialResult={initialResult}
            actions={filters.actions}
            decisions={filters.decisions}
            displayUser={displayUser}
          />
        </CardContent>
      </Card>
    </div>
  );
}