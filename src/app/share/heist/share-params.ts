import {
  MAX_ALIAS_LENGTH,
  MAX_PROJECT_LENGTH,
  MAX_TIMESTAMP_LENGTH,
  parseFindingsCount,
  parseRank,
  parseScore,
  sanitizeText,
} from "@/lib/og/heist-card";

function getRankFromScore(score: number): string {
  if (score >= 90) return "S";
  if (score >= 75) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

/** First value of a query parameter; Next.js hands a repeated one over as an array. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface ShareHeistParams {
  projectName: string;
  playerAlias: string;
  /** Integer 0-100, or undefined when no numeric score was supplied. */
  score?: number;
  rank?: string;
  findingsCount?: number;
  timestamp?: string;
  /** Query string for `/api/og/heist` and the canonical share URL. */
  query: string;
}

/**
 * Read the share link the same way `/api/og/heist` reads it.
 *
 * The page, its metadata and the preview image are built from one query string. The
 * image went through `@/lib/og/heist-card` (control characters stripped, lengths capped,
 * score clamped to 0-100, a negative or blank findings count dropped) while the page used
 * the raw values, so `score=150` produced "a security score of 150" beside a card showing
 * 100, and `score=` was ranked D.
 */
export function resolveShareHeistParams(
  searchParams: Record<string, string | string[] | undefined>,
): ShareHeistParams {
  const rawScore = first(searchParams.score);
  const score =
    rawScore !== undefined && rawScore.trim() !== "" && Number.isFinite(Number(rawScore))
      ? parseScore(rawScore)
      : undefined;

  const projectName =
    sanitizeText(first(searchParams.project), MAX_PROJECT_LENGTH) || "The Royal Mint";
  const playerAlias = sanitizeText(first(searchParams.alias), MAX_ALIAS_LENGTH) || "The Professor";
  const timestamp = sanitizeText(first(searchParams.timestamp), MAX_TIMESTAMP_LENGTH) || undefined;
  const suppliedRank = parseRank(first(searchParams.rank));
  const findingsCount = parseFindingsCount(first(searchParams.findingsCount));

  const params = new URLSearchParams({
    project: projectName,
    alias: playerAlias,
    score: String(score ?? 100),
  });
  if (timestamp) params.set("timestamp", timestamp);
  if (suppliedRank) params.set("rank", suppliedRank);
  if (findingsCount !== undefined) params.set("findingsCount", findingsCount);

  return {
    projectName,
    playerAlias,
    score,
    rank: suppliedRank ?? (score !== undefined ? getRankFromScore(score) : undefined),
    findingsCount: findingsCount !== undefined ? Number(findingsCount) : undefined,
    timestamp,
    query: params.toString(),
  };
}
