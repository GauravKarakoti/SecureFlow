import type { Metadata } from 'next';
import Link from 'next/link';

// Falls back to the production domain so this works even if the env var
// isn't set locally — mirrors the domain already hardcoded in the tweet intent.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://secure-flow-six.vercel.app';

type SearchParams = Promise<{
  project?: string;
  score?: string;
  rank?: string;
  findingsCount?: string;
}>;

// Mirrors the tier labels used by the OG image generator so the share page
// copy stays in sync with the badge shown in the preview card.
const TIER_QUOTES: Record<string, string> = {
  S: 'Ghost protocol. Zero traces left behind.',
  A: 'The vault is empty. Clean getaway.',
  B: 'Job done. A few loose ends remain.',
  C: 'Amateur hour. The vault noticed.',
  D: 'Blown cover. Back to the drawing board.',
};

function getRankFromScore(score: number): string {
  if (score >= 90) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

function buildOgQuery(params: {
  project: string;
  score?: string;
  rank?: string;
  findingsCount?: string;
}) {
  const qs = new URLSearchParams({ project: params.project });
  if (params.score) qs.set('score', params.score);
  if (params.rank) qs.set('rank', params.rank);
  if (params.findingsCount) qs.set('findingsCount', params.findingsCount);
  return qs.toString();
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { project, score, rank, findingsCount } = await searchParams;
  const projectName = project || 'The Royal Mint';
  const query = buildOgQuery({ project: projectName, score, rank, findingsCount });
  const imageUrl = `${APP_URL}/api/og/heist?${query}`;

  const numericScore = score !== undefined ? Number(score) : undefined;
  const resolvedRank =
    rank?.toUpperCase() && TIER_QUOTES[rank.toUpperCase()]
      ? rank.toUpperCase()
      : numericScore !== undefined && !Number.isNaN(numericScore)
      ? getRankFromScore(numericScore)
      : undefined;

  const title = numericScore !== undefined
    ? `Audit Passed: ${projectName} — Score ${numericScore} 🎭`
    : `Audit Passed: ${projectName} 🎭`;

  const description = resolvedRank
    ? `${TIER_QUOTES[resolvedRank]} Audit passed via SecureFlow.`
    : 'The vault is empty. Zero traces left behind. Audit passed via SecureFlow.';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${APP_URL}/share/heist?${query}`,
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
  const { project, score, rank, findingsCount } = await searchParams;
  const projectName = project || 'The Royal Mint';
  const query = buildOgQuery({ project: projectName, score, rank, findingsCount });
  const imageUrl = `/api/og/heist?${query}`;

  const numericScore = score !== undefined ? Number(score) : undefined;
  const resolvedRank =
    rank?.toUpperCase() && TIER_QUOTES[rank.toUpperCase()]
      ? rank.toUpperCase()
      : numericScore !== undefined && !Number.isNaN(numericScore)
      ? getRankFromScore(numericScore)
      : undefined;

  const tagline = resolvedRank ? TIER_QUOTES[resolvedRank] : 'The vault is empty. Zero traces left behind. 🎭';

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <img
        src={imageUrl}
        alt="Heist Success Card"
        className="w-full max-w-2xl rounded-md border border-red-900/50 shadow-2xl mb-8"
      />
      <p className="text-red-500 font-bold text-lg mb-2">Audit passed via SecureFlow.</p>
      <p className="text-zinc-400 text-sm mb-8 text-center max-w-md">{tagline}</p>
      <Link
        href="/"
        className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded shadow-lg transition-all"
      >
        Join the Resistance
      </Link>
    </div>
  );
}