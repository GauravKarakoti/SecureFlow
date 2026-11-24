/**
 * POST /api/findings/[id]/issue - Create a GitHub issue from a security finding.
 * GET  /api/findings/[id]/issue - Get pre-filled issue template and creation status.
 *
 * Implements Issue #1987.
 */

import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import { getFindingIssuePrefill, createIssueForFinding } from "@/lib/actions/finding-issues";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  async (_req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const result = await getFindingIssuePrefill(id);

    if (!result.ok) {
      const status =
        result.error === "Unauthorized" ? 401 : result.error?.includes("not found") ? 404 : 400;
      throw new AppError(result.error || "Failed to load prefill", status);
    }

    return NextResponse.json(result);
  },
);

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;

    let body: { title?: string; body?: string } | undefined;
    try {
      body = await req.json();
    } catch {
      // Empty or invalid body is accepted as using default template
      body = undefined;
    }

    const result = await createIssueForFinding(id, body);

    if (!result.ok) {
      if (result.error?.includes("Permission denied") || result.error?.includes("Unauthorized")) {
        throw new AppError(result.error, 403);
      }
      if (result.error?.includes("not found")) {
        throw new AppError(result.error, 404);
      }
      if (result.error?.includes("already been created")) {
        return NextResponse.json(
          { ok: false, error: result.error, issueUrl: result.issueUrl },
          { status: 409 },
        );
      }
      throw new AppError(result.error || "Failed to create issue", 400);
    }

    return NextResponse.json(result, { status: 201 });
  },
);
