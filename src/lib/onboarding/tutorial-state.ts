import { prisma } from '@/lib/prisma';

/**
 * Fetches the current onboarding progress for a user.
 */
export async function getUserOnboardingProgress(userId: string) {
  return prisma.onboardingProgress.findUnique({
    where: { userId }
  });
}

/**
 * Updates the user's onboarding progress.
 */
export async function updateUserOnboardingProgress(
  userId: string,
  currentStep: number,
  lastViewedStep: string,
  isCompleted: boolean
) {
  return prisma.onboardingProgress.upsert({
    where: { userId },
    update: { currentStep, lastViewedStep, isCompleted },
    create: { userId, currentStep, lastViewedStep, isCompleted }
  });
}
