import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { getSuppressionRulesWithStats } from "@/lib/suppression-rules/service";
import SuppressionRulesClient from "./suppression-rules-client";
import { ShieldAlert } from "lucide-react";

export const metadata = {
  title: "Suppression Rules · SecureFlow Admin",
  description: "Manage installation-wide finding suppression rules and policies.",
};

export default async function AdminSuppressionRulesPage() {
  await auth();

  const [rules, repositories] = await Promise.all([
    getSuppressionRulesWithStats(),
    prisma.repository.findMany({
      select: { id: true, fullName: true },
      orderBy: { fullName: "asc" },
      take: 200,
    }),
  ]);

  return (
    <div className="space-y-8">
      <header className="flex items-start gap-4">
        <div className="w-11 h-11 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center justify-center shrink-0">
          <ShieldAlert className="w-5 h-5 text-red-600 dark:text-red-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Suppression Rules</h1>
          <p className="text-muted-foreground mt-2">
            Configure organization-wide suppression rules across repositories for specific finding
            types, policies, or file patterns. Matches are recorded and tracked with 30-day impact
            metrics.
          </p>
        </div>
      </header>

      <SuppressionRulesClient initialRules={rules} repositories={repositories} />
    </div>
  );
}
