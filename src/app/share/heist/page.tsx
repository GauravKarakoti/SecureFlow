import type { Metadata } from 'next';
import Link from 'next/link';

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://secure-flow-six.vercel.app';

type SearchParams = Promise<{
  project?: string;
  alias?: string;
  score?: string;
  timestamp?: string;
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
  } = await searchParams;

  const projectName = project || 'The Royal Mint';
  const playerAlias = alias || 'The Professor';
  const securityScore = score || '100';

  const params = new URLSearchParams({
    project: projectName,
    alias: playerAlias,
    score: securityScore,
  });

  if (timestamp) {
    params.set('timestamp', timestamp);
  }

  const imageUrl = `/api/og/heist?${params.toString()}`;

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <img
        src={imageUrl}
        alt="Heist Success Card"
        className="w-full max-w-2xl rounded-md border border-red-900/50 shadow-2xl mb-8"
      />

      <p className="text-red-500 font-bold text-lg mb-2">
        Audit passed via SecureFlow.
      </p>

      <p className="text-zinc-400 text-sm mb-8 text-center max-w-md">
        Alias: <strong>{playerAlias}</strong> • Security Score:{' '}
        <strong>{securityScore}</strong>
      </p>

      <Link
        href="/"
        className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded shadow-lg transition-all"
      >
        Join the Resistance
      </Link>
    </div>
  );
}
