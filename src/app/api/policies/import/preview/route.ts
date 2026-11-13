import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import prisma from "@/lib/prisma";
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";
import { withErrorHandler, AppError } from "@/lib/middleware/error-handler";
import {
  MAX_POLICY_FILE_BYTES,
  validatePolicyImportPayload,
  computeImportPreview,
} from "@/lib/policies/export-import";

/**
 * POST /api/policies/import/preview
 * Validates the uploaded JSON file and previews proposed changes against existing policies.
 */
async function postHandler(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    throw new AppError("Unauthorized", 401);
  }

  const userId = session.user.id;

  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_FILE_BYTES) {
    throw new AppError("Policy file exceeds maximum allowed size (1 MB)", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError("Malformed JSON file", 400);
  }

  const validation = validatePolicyImportPayload(body);
  if (!validation.success || !validation.data) {
    throw new AppError(validation.error || "Invalid policy file", 400);
  }

  const [existingTemplates, userToggles] = await Promise.all([
    prisma.policyTemplate.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        severity: true,
        action: true,
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

  const preview = computeImportPreview(validation.data.policies, existingTemplates, userToggles);

  return NextResponse.json(preview, { status: 200 });
}

export const POST = withRateLimit(
  withErrorHandler(postHandler) as (req: NextRequest) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: "policies:import:preview" },
);
