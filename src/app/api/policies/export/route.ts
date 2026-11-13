import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import type { PolicyExportFile } from "@/lib/policies/export-import";

/**
 * GET: Export current user's configured policies as versioned JSON.
 * Returns only portable attributes (name, description, severity, action, rules, complianceTags, enabled).
 * Excludes internal IDs and user metadata.
 */
async function getHandler(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }

  const userId = session.user.id;

  const [templates, userToggles] = await Promise.all([
    prisma.policyTemplate.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        severity: true,
        action: true,
        rules: true,
        complianceTags: true,
        isDefault: true,
      },
    }),
    prisma.userPolicyToggle.findMany({
      where: { userId },
      select: {
        policyTemplateId: true,
        isActive: true,
      },
    }),
  ]);

  const toggleMap = new Map(userToggles.map((t: any) => [t.policyTemplateId, t.isActive]));

  const policies = templates.map((t: any) => ({
    name: t.name,
    description: t.description,
    severity: t.severity,
    enabled: toggleMap.has(t.id) ? toggleMap.get(t.id)! : t.isDefault,
    action: t.action,
    rules: t.rules as any,
    complianceTags: t.complianceTags,
  }));

  const exportPayload: PolicyExportFile = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    policies,
  };

  return new NextResponse(JSON.stringify(exportPayload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="secureflow-policies-${new Date().toISOString().split("T")[0]}.json"`,
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(getHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "policies:export" },
);
