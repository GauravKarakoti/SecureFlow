import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  generateAuditorComplianceDossier,
  generateAuditorPdfHtml,
  type ComplianceExportFilters,
} from "@/lib/compliance/auditor-exporter";
import { buildComplianceSarifDocument } from "@/lib/compliance/sarif-exporter";
import { enrichFindingsWithComplianceTags } from "@/lib/policies/compliance-engine";

/**
 * Parse an ISO-8601 date string.
 */
function parseDateParam(raw: string | null, name: string): Date | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(`Invalid \`${name}\` parameter: expected an ISO-8601 date string.`, 400);
  }
  return parsed;
}

/**
 * GET /api/compliance/export
 * Generates structured SARIF, PDF/HTML executive summaries, or JSON compliance dossiers.
 */
async function handler(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized access to compliance export", 401);
  }

  const { searchParams } = req.nextUrl;
  const format = (searchParams.get("format") || "json").toLowerCase();
  const repositoryId = searchParams.get("repositoryId") || undefined;
  const framework = searchParams.get("framework") || undefined;
  const from = parseDateParam(searchParams.get("from"), "from");
  const to = parseDateParam(searchParams.get("to"), "to");
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 500), 2000) : 500;

  const filters: ComplianceExportFilters = {
    repositoryId,
    framework,
    from,
    to,
    limit,
  };

  // ── SARIF 2.1.0 Export ──────────────────────────────────────────────────────
  if (format === "sarif") {
    const fromDate = from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const toDate = to || new Date();

    const rawFindings = await prisma.finding.findMany({
      where: {
        createdAt: { gte: fromDate, lte: toDate },
        ...(repositoryId ? { scanResult: { pullRequest: { repositoryId } } } : {}),
      },
      select: {
        id: true,
        type: true,
        severity: true,
        fileLocation: true,
        lineStart: true,
        lineEnd: true,
        explanation: true,
        remediation: true,
        fingerprint: true,
        complianceTags: true,
      },
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    const enriched = enrichFindingsWithComplianceTags(rawFindings as any);
    const sarifDoc = buildComplianceSarifDocument(enriched);

    const filename = `secureflow-compliance-${new Date().toISOString().slice(0, 10)}.sarif`;

    return new NextResponse(JSON.stringify(sarifDoc, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/sarif+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Compliance-Findings-Count": String(enriched.length),
      },
    });
  }

  // ── Dossier generation for JSON & PDF/HTML ──────────────────────────────────
  const dossier = await generateAuditorComplianceDossier(filters);

  // ── PDF / HTML Printable Summary ────────────────────────────────────────────
  if (format === "pdf" || format === "html") {
    const html = generateAuditorPdfHtml(dossier);
    const filename = `secureflow-compliance-audit-${dossier.reportId}.html`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Compliance-Report-Id": dossier.reportId,
      },
    });
  }

  // ── JSON Compliance Dossier (Default) ───────────────────────────────────────
  return NextResponse.json(dossier, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Compliance-Report-Id": dossier.reportId,
    },
  });
}

export const GET = withRateLimit(
  withErrorHandler(handler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "compliance:export:get" },
);

