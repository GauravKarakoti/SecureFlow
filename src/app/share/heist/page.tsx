import type { Metadata } from "next";
import { HeistTransmission } from "./heist-transmission";
import { resolveShareHeistParams } from "./share-params";

const TIER_QUOTES: Record<string, string> = {
  S: "Ghost protocol. Zero traces left behind.",
  A: "The vault is empty. Clean getaway.",
  B: "Job done. A few loose ends remain.",
  C: "Amateur hour. The vault noticed.",
  D: "Blown cover. Back to the drawing board.",
};

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://secure-flow-six.vercel.app");

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const { projectName, playerAlias, score, query } = resolveShareHeistParams(await searchParams);

  const imageUrl = `${APP_URL}/api/og/heist?${query}`;

  const title = `Audit Passed: ${projectName} 🎭`;

  const description = `${playerAlias} secured the vault with a security score of ${score ?? 100}.`;

  return {
    metadataBase: new URL(APP_URL),
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${APP_URL}/share/heist?${query}`,
      siteName: "SecureFlow",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: "Heist Success Card",
        },
      ],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function HeistSharePage({ searchParams }: { searchParams: SearchParams }) {
  const { projectName, score, rank, findingsCount, query } = resolveShareHeistParams(
    await searchParams,
  );

  const tagline = rank ? TIER_QUOTES[rank] : "The vault is empty. Zero traces left behind. 🎭";

  // The page stays a server component (so generateMetadata + OG/Twitter
  // cards keep working) and hands the resolved data to the client
  // transmission component, which drives the sequential decode.
  return (
    <HeistTransmission
      projectName={projectName}
      score={score}
      rank={rank}
      findingsCount={findingsCount}
      tagline={tagline}
      imageUrl={`/api/og/heist?${query}`}
    />
  );
}
