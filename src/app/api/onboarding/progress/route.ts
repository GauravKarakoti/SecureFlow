import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { getUserOnboardingProgress, updateUserOnboardingProgress } from '@/lib/onboarding/tutorial-state';

/**
 * GET /api/onboarding/progress
 * Retrieves the current onboarding state for the authenticated user.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const progress = await getUserOnboardingProgress(session.user.id);
    return NextResponse.json({ progress });
  } catch (error) {
    console.error('[ONBOARDING_GET]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/onboarding/progress
 * Updates the user's onboarding progress.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { currentStep, lastViewedStep, isCompleted } = body;

    const progress = await updateUserOnboardingProgress(
      session.user.id,
      currentStep,
      lastViewedStep,
      isCompleted
    );

    return NextResponse.json({ success: true, progress });
  } catch (error) {
    console.error('[ONBOARDING_POST]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
