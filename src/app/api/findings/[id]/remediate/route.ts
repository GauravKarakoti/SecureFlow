import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth'; 
// 2. Correct default Prisma import
import prisma from '@/lib/prisma'; 
import { generateRemediationPatchFlow } from '@/ai/flows/generate-remediation-patch';

/**
 * POST /api/findings/[id]/remediate
 * Triggers the AI flow to generate a remediation patch for a specific finding.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const findingId = id;
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
