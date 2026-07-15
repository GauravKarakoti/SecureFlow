import type { Metadata } from 'next';
import { HeistTransmission } from './heist-transmission';

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://secure-flow-six.vercel.app';

type SearchParams = Promise<{
  project?: string;
  alias?: string;
  score?: string;
  timestamp?: string;
  rank?: string;
  findingsCount?: string;
}>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const {
    project,
    alias,
    score,
    timestamp,
  } = await searchParams;

  const projectName = project || 'The Royal Mint';
  const playerAlias = alias || 'The Professor';
  const securityScore = score || '100';
  const operationTimestamp = timestamp || '';

  const params = new URLSearchParams({
    project: projectName,
    alias: playerAlias,
    score: securityScore,
  });

  if (operationTimestamp) {
    params.set('timestamp', operationTimestamp);
  }

  const imageUrl = `${APP_URL}/api/og/heist?${params.toString()}`;

  const title = `Audit Passed: ${projectName} 🎭`;

  const description = `${playerAlias} secured the vault with a security score of ${securityScore}.`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${APP_URL}/share/heist?${params.toString()}`,
      siteName: 'SecureFlow',
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: 'Heist Success Card',
        },
      ],
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function HeistSharePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const {
    project,
    alias,
    score,
    timestamp,
    rank,
    findingsCount,
  } = await searchParams;

  const projectName = project || 'The Royal Mint';
  const playerAlias = alias || 'The Professor';
  const securityScore = score || '100';

  // 1. Retain the URL param and image construction from `main`
  const params = new URLSearchParams({
    project: projectName,
    alias: playerAlias,
    score: securityScore,
  });

  if (timestamp) {
    params.set('timestamp', timestamp);
  }

  const imageUrl = `/api/og/heist?${params.toString()}`;

  // 2. Retain the score, rank, and tagline resolution from `#250-decode-heist`
  const numericScore = score !== undefined ? Number(score) : undefined;
  const cleanScore =
    numericScore !== undefined && !Number.isNaN(numericScore)
      ? numericScore
      : undefined;

  const resolvedRank =
    rank?.toUpperCase() && TIER_QUOTES[rank.toUpperCase()]
      ? rank.toUpperCase()
      : cleanScore !== undefined
      ? getRankFromScore(cleanScore)
      : undefined;

  const tagline = resolvedRank
    ? TIER_QUOTES[resolvedRank]
    : 'The vault is empty. Zero traces left behind. 🎭';

  const cleanFindings =
    findingsCount !== undefined && !Number.isNaN(Number(findingsCount))
      ? Number(findingsCount)
      : undefined;

  // The page stays a server component (so generateMetadata + OG/Twitter
  // cards keep working) and hands the resolved data to the client
  // transmission component, which drives the sequential decode.
  return (
    <HeistTransmission
      projectName={projectName}
      score={cleanScore}
      rank={resolvedRank}
      findingsCount={cleanFindings}
      tagline={tagline}
      imageUrl={imageUrl}
    />
  );
}