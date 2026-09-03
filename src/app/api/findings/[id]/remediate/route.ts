import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import { generateRemediationPatchFlow } from '@/ai/flows/generate-remediation-patch';

/**
 * POST /api/findings/[id]/remediate
 * Triggers the AI flow to generate a remediation patch for a specific finding.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const findingId = params.id;
    const finding = await prisma.finding.findUnique({
      where: { id: findingId },
      include: { repository: true }
    });

    if (!finding) {
      return NextResponse.json({ error: 'Finding not found' }, { status: 404 });
    }

    // Trigger AI flow
    const aiResult = await generateRemediationPatchFlow({
      vulnerableCode: finding.codeSnippet || '',
      findingDescription: finding.description,
      filePath: finding.filePath
    });

    // Save to database
    const patch = await prisma.remediationPatch.upsert({
      where: { findingId },
      update: { patchDiff: aiResult.patchDiff, status: 'GENERATED' },
      create: { findingId, patchDiff: aiResult.patchDiff, status: 'GENERATED' }
    });

    return NextResponse.json({ success: true, patch, explanation: aiResult.explanation });
  } catch (error) {
    console.error('[REMEDIATE_PATCH_ERROR]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
