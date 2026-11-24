import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { compareScans, type ComparableScanInput } from "@/lib/scans/comparison";

export const dynamic = "force-dynamic";

/**
 * Checks whether a gateConfig or metadata blob records skipped files or partial scan.
 */
function isGateConfigPartial(gateConfig: unknown): boolean {
  if (!gateConfig || typeof gateConfig !== "object") return false;
  const gc = gateConfig as Record<string, unknown>;
  if (gc.isPartialScan === true) return true;
  if (Array.isArray(gc.skippedFiles) && gc.skippedFiles.length > 0) return true;
  return false;
}

/**
 * Maps a database ScanResult into a ComparableScanInput.
 */
function mapScanResultToComparableInput(scanResult: {
  id: string;
  headSha?: string | null;
  createdAt: Date;
  riskScore: number;
  policyDecision?: string;
  gateConfig?: unknown;
  findings: Array<{
    id: string;
    fingerprint: string;
    type: string;
    severity: string;
    fileLocation: string;
    lineStart?: number | null;
    lineEnd?: number | null;
    codeSnippet?: string | null;
    explanation?: string | null;
    remediation?: string | null;
    createdAt?: Date;
  }>;
}): ComparableScanInput {
  const isPartial = isGateConfigPartial(scanResult.gateConfig);

  return {
    id: scanResult.id,
    headSha: scanResult.headSha,
    createdAt: scanResult.createdAt,
    riskScore: scanResult.riskScore,
    policyDecision: scanResult.policyDecision,
    findings: scanResult.findings || [],
    isPartial,
    status: "COMPLETED",
  };
}

/**
 * GET /api/scans/compare
 *
 * Query parameters:
 * - `pullRequestId`: ID of the pull request (optional if baseScanId and targetScanId provided)
 * - `baseScanId`: ID of earlier/baseline scan (optional, defaults to 2nd newest)
 * - `targetScanId`: ID of later/target scan (optional, defaults to 1st newest)
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const { searchParams } = new URL(req.url);
    const pullRequestId = searchParams.get("pullRequestId")?.trim();
    const baseScanId = searchParams.get("baseScanId")?.trim();
    const targetScanId = searchParams.get("targetScanId")?.trim();

    if (!pullRequestId && (!baseScanId || !targetScanId)) {
      return NextResponse.json(
        { error: "Either pullRequestId or both baseScanId and targetScanId are required" },
        { status: 400 },
      );
    }

    // Branch A: Querying by pullRequestId
    if (pullRequestId) {
      const pr = await prisma.pullRequest.findUnique({
        where: { id: pullRequestId },
        include: {
          repository: {
            select: { id: true, fullName: true, userId: true },
          },
          scans: {
            orderBy: { createdAt: "desc" },
            include: {
              findings: true,
            },
          },
        },
      });

      if (!pr) {
        return NextResponse.json({ error: "Pull request not found" }, { status: 404 });
      }

      // Authorization check: User must own the repository
      if (pr.repository.userId !== userId) {
        return NextResponse.json(
          { error: "Forbidden: You do not have access to this repository" },
          { status: 403 },
        );
      }

      const availableScans = pr.scans.map((s: any) => ({
        id: s.id,
        headSha: s.headSha,
        createdAt: s.createdAt,
        riskScore: s.riskScore,
        policyDecision: s.policyDecision,
        findingsCount: s.findings.length,
        isPartial: isGateConfigPartial(s.gateConfig),
      }));

      if (pr.scans.length < 2) {
        return NextResponse.json({
          isComparable: false,
          incomparableReason:
            "At least two scans of this pull request are required for comparison.",
          pullRequest: {
            id: pr.id,
            prNumber: pr.prNumber,
            title: pr.title,
            repositoryFullName: pr.repository.fullName,
          },
          scans: availableScans,
        });
      }

      // Pick selected scans or default to latest two
      let targetScanRow = pr.scans[0];
      let baseScanRow = pr.scans[1];

      if (baseScanId) {
        const found = pr.scans.find((s: any) => s.id === baseScanId);
        if (!found) {
          return NextResponse.json({ error: `Base scan ${baseScanId} not found` }, { status: 404 });
        }
        baseScanRow = found;
      }

      if (targetScanId) {
        const found = pr.scans.find((s: any) => s.id === targetScanId);
        if (!found) {
          return NextResponse.json(
            { error: `Target scan ${targetScanId} not found` },
            { status: 404 },
          );
        }
        targetScanRow = found;
      }

      const baseInput = mapScanResultToComparableInput(baseScanRow);
      const targetInput = mapScanResultToComparableInput(targetScanRow);

      const comparison = compareScans(baseInput, targetInput);

      return NextResponse.json({
        ...comparison,
        pullRequest: {
          id: pr.id,
          prNumber: pr.prNumber,
          title: pr.title,
          repositoryFullName: pr.repository.fullName,
        },
        scans: availableScans,
      });
    }

    // Branch B: Querying directly by baseScanId and targetScanId
    const [baseRaw, targetRaw] = await Promise.all([
      prisma.scanResult.findUnique({
        where: { id: baseScanId! },
        include: {
          findings: true,
          pullRequest: {
            include: { repository: { select: { id: true, fullName: true, userId: true } } },
          },
        },
      }),
      prisma.scanResult.findUnique({
        where: { id: targetScanId! },
        include: {
          findings: true,
          pullRequest: {
            include: { repository: { select: { id: true, fullName: true, userId: true } } },
          },
        },
      }),
    ]);

    if (!baseRaw || !targetRaw) {
      return NextResponse.json({ error: "One or both scans not found" }, { status: 404 });
    }

    if (baseRaw.pullRequestId !== targetRaw.pullRequestId) {
      return NextResponse.json(
        { error: "Scans must belong to the same pull request" },
        { status: 400 },
      );
    }

    if (baseRaw.pullRequest.repository.userId !== userId) {
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this repository" },
        { status: 403 },
      );
    }

    const baseInput = mapScanResultToComparableInput(baseRaw);
    const targetInput = mapScanResultToComparableInput(targetRaw);

    const comparison = compareScans(baseInput, targetInput);

    return NextResponse.json({
      ...comparison,
      pullRequest: {
        id: baseRaw.pullRequest.id,
        prNumber: baseRaw.pullRequest.prNumber,
        title: baseRaw.pullRequest.title,
        repositoryFullName: baseRaw.pullRequest.repository.fullName,
      },
    });
  } catch (err) {
    console.error("[ScanComparison] Error in GET /api/scans/compare:", err);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
