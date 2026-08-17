import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { App } from 'octokit';

export default async function GitHubSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ installation_id?: string; setup_action?: string }>;
}) {
  const { installation_id } = await searchParams;

  if (!installation_id) {
    redirect('/dashboard');
  }

  const session = await auth();
  
  // 1. Extract the ID to a variable
  const userId = session?.user?.id;

  // 2. Check the variable. If it doesn't exist, redirect.
  if (!userId) {
    const callback = encodeURIComponent(`/setup?installation_id=${installation_id}`);
    redirect(`/login?callbackUrl=${callback}`);
  }

  if (process.env.NEXT_PUBLIC_MOCK_DB === 'true') {
    await prisma.repository.upsert({
      where: { githubId: BigInt(123456) },
      update: { 
        isActive: true,
        userId: userId
      }, 
      create: {
        githubId: BigInt(123456),
        fullName: 'mock-owner/mock-repo',
        owner: 'mock-owner',
        userId: userId,
      },
    });
    redirect('/dashboard');
  }

  const appId = process.env.GITHUB_APP_ID!;
  const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n');

  const appClient = new App({ appId, privateKey });
  const octokit = await appClient.getInstallationOctokit(Number(installation_id));

  const repositories = await octokit.paginate(
    octokit.rest.apps.listReposAccessibleToInstallation,
    {
      per_page: 100, // Fetch up to 100 per request to speed up the process
    }
  );

  // 5. Save the repositories to Prisma, linked to the guaranteed logged-in user
  // Note: octokit.paginate returns the array of repositories directly!
  const repoPromises = repositories.map((repo: any) => {
    return prisma.repository.upsert({
      where: { githubId: repo.id },
      update: { 
        isActive: true,
        userId: userId // 3. Use the strictly-typed variable here
      }, 
      create: {
        githubId: repo.id,
        fullName: repo.full_name,
        owner: repo.owner.login,
        userId: userId, // 4. And use it here
      },
    });
  });

  await Promise.all(repoPromises);

  redirect('/dashboard');
}