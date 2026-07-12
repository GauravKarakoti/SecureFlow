import type { Metadata } from 'next';
import Link from 'next/link';

// Falls back to the production domain so this works even if the env var
// isn't set locally — mirrors the domain already hardcoded in the tweet intent.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://secure-flow-six.vercel.app';

type SearchParams = Promise<{ project?: string }>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { project } = await searchParams;
  const projectName = project || 'The Royal Mint';
  const imageUrl = `${APP_URL}/api/og/heist?project=${encodeURIComponent(projectName)}`;
  const title = `Audit Passed: ${projectName} 🎭`;
  const description = 'The vault is empty. Zero traces left behind. Audit passed via SecureFlow.';

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${APP_URL}/share/heist?project=${encodeURIComponent(projectName)}`,
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
  const { project } = await searchParams;
  const projectName = project || 'The Royal Mint';
  const imageUrl = `/api/og/heist?project=${encodeURIComponent(projectName)}`;

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      <img
        src={imageUrl}
        alt="Heist Success Card"
        className="w-full max-w-2xl rounded-md border border-red-900/50 shadow-2xl mb-8"
      />
      <p className="text-red-500 font-bold text-lg mb-2">Audit passed via SecureFlow.</p>
      <p className="text-zinc-400 text-sm mb-8 text-center max-w-md">
        The vault is empty. Zero traces left behind. 🎭
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