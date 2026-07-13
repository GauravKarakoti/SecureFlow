import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

type Tier = {
  label: string;
  color: string;
  glow: string;
  quote: string;
};

// Rank tiers — mirrors the "clearance level" language used elsewhere in the
// cyber-heist theme. Falls back gracefully when no explicit rank is passed.
const TIERS: Record<string, Tier> = {
  S: {
    label: 'S',
    color: '#facc15',
    glow: 'rgba(250, 204, 21, 0.35)',
    quote: 'Ghost protocol. Zero traces left behind.',
  },
  A: {
    label: 'A',
    color: '#ef4444',
    glow: 'rgba(239, 68, 68, 0.35)',
    quote: 'The vault is empty. Clean getaway.',
  },
  B: {
    label: 'B',
    color: '#fb923c',
    glow: 'rgba(251, 146, 60, 0.35)',
    quote: 'Job done. A few loose ends remain.',
  },
  C: {
    label: 'C',
    color: '#a3a3a3',
    glow: 'rgba(163, 163, 163, 0.35)',
    quote: 'Amateur hour. The vault noticed.',
  },
  D: {
    label: 'D',
    color: '#71717a',
    glow: 'rgba(113, 113, 122, 0.35)',
    quote: 'Blown cover. Back to the drawing board.',
  },
};

function getTierFromScore(score: number): Tier {
  if (score >= 90) return TIERS.S;
  if (score >= 75) return TIERS.A;
  if (score >= 60) return TIERS.B;
  if (score >= 40) return TIERS.C;
  return TIERS.D;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get('project') || 'Classified Target';

    const rawScore = searchParams.get('score');
    const score = rawScore !== null ? Math.max(0, Math.min(100, Number(rawScore))) : null;
    const hasScore = score !== null && !Number.isNaN(score);

    const rawFindings = searchParams.get('findingsCount');
    const findingsCount = rawFindings !== null ? Math.max(0, Number(rawFindings)) : null;
    const hasFindings = findingsCount !== null && !Number.isNaN(findingsCount);

    // Explicit ?rank= overrides the score-derived tier; otherwise derive it.
    const rawRank = searchParams.get('rank')?.toUpperCase();
    const tier =
      rawRank && TIERS[rawRank]
        ? TIERS[rawRank]
        : hasScore
        ? getTierFromScore(score as number)
        : null;

    const accent = tier?.color ?? '#ef4444';
    const accentGlow = tier?.glow ?? 'rgba(239, 68, 68, 0.35)';
    const quote = tier?.quote ?? 'The vault is empty. Zero traces left behind. 🎭';

    // True once we have any real data to show on the right side (score dial,
    // rank badge, or findings chip). When false, none of those render, so we
    // fall back to a default "wax seal" emblem to avoid a lopsided layout.
    const hasAnyData = hasScore || !!tier || hasFindings;

    return new ImageResponse(
      (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            backgroundColor: '#09090b',
            color: '#ffffff',
            fontFamily: 'monospace',
            border: `12px solid ${accent}`,
            position: 'relative',
          }}
        >
          {/* Top HUD bar */}
          <div
            style={{
              display: 'flex',
              width: '100%',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '22px 40px',
              borderBottom: `2px solid ${accent}33`,
              backgroundColor: '#000000',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: '22px',
                letterSpacing: '4px',
                color: '#71717a',
                textTransform: 'uppercase',
              }}
            >
              SecureFlow // Heist Audit
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: '20px',
                letterSpacing: '3px',
                color: accent,
                textTransform: 'uppercase',
              }}
            >
              ● Live Feed
            </div>
          </div>

          {/* Main body */}
          <div
            style={{
              display: 'flex',
              flex: 1,
              width: '100%',
              padding: '30px 50px',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            {/* Left: narrative + target */}
            <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '620px' }}>
              <h1
                style={{
                  fontSize: '58px',
                  color: accent,
                  textTransform: 'uppercase',
                  fontWeight: 'bold',
                  letterSpacing: '2px',
                  marginBottom: '18px',
                  marginTop: 0,
                }}
              >
                BELLA CIAO
              </h1>
              <p
                style={{
                  fontSize: '26px',
                  color: '#a1a1aa',
                  marginBottom: '36px',
                  marginTop: 0,
                  lineHeight: 1.4,
                }}
              >
                &ldquo;{quote}&rdquo;
              </p>
              <div
                style={{
                  display: 'flex',
                  padding: '14px 28px',
                  backgroundColor: accent,
                  color: '#09090b',
                  borderRadius: '6px',
                  fontSize: '24px',
                  fontWeight: 'bold',
                  letterSpacing: '1px',
                  alignSelf: 'flex-start',
                }}
              >
                TARGET: {projectName}
              </div>
            </div>

            {/* Right: score dial + badges */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              {hasScore && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '240px',
                    height: '240px',
                    borderRadius: '50%',
                    border: `6px solid ${accent}`,
                    backgroundColor: `${accentGlow}`,
                    marginBottom: '24px',
                  }}
                >
                  <div style={{ display: 'flex', fontSize: '80px', fontWeight: 'bold', color: '#ffffff' }}>
                    {score}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      fontSize: '22px',
                      color: '#e4e4e7',
                      letterSpacing: '3px',
                      textTransform: 'uppercase',
                    }}
                  >
                    Score
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '16px' }}>
                {tier && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      padding: '10px 20px',
                      borderRadius: '8px',
                      border: `2px solid ${accent}`,
                      backgroundColor: '#000000',
                    }}
                  >
                    <div style={{ display: 'flex', fontSize: '34px', fontWeight: 'bold', color: accent }}>
                      RANK {tier.label}
                    </div>
                  </div>
                )}

                {hasFindings && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      padding: '10px 20px',
                      borderRadius: '8px',
                      border: '2px solid #3f3f46',
                      backgroundColor: '#000000',
                    }}
                  >
                    <div style={{ display: 'flex', fontSize: '34px', fontWeight: 'bold', color: '#ffffff' }}>
                      {findingsCount}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        fontSize: '16px',
                        color: '#71717a',
                        letterSpacing: '2px',
                        textTransform: 'uppercase',
                      }}
                    >
                      Findings
                    </div>
                  </div>
                )}
              </div>

              {/* Fallback emblem so the right column is never empty when the
                  link carries no score/rank/findings data. */}
              {!hasAnyData && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '220px',
                    height: '220px',
                    borderRadius: '50%',
                    border: `6px solid ${accent}`,
                    backgroundColor: `${accentGlow}`,
                  }}
                >
                  <div style={{ display: 'flex', fontSize: '64px' }}>🎭</div>
                  <div
                    style={{
                      display: 'flex',
                      fontSize: '18px',
                      color: '#e4e4e7',
                      letterSpacing: '2px',
                      textTransform: 'uppercase',
                      marginTop: '8px',
                    }}
                  >
                    Passed
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Bottom footer strip */}
          <div
            style={{
              display: 'flex',
              width: '100%',
              padding: '16px 40px',
              borderTop: `2px solid ${accent}33`,
              justifyContent: 'space-between',
              backgroundColor: '#000000',
              fontSize: '18px',
              color: '#52525b',
              letterSpacing: '2px',
              textTransform: 'uppercase',
            }}
          >
            <div style={{ display: 'flex' }}>Audit passed via SecureFlow</div>
            <div style={{ display: 'flex' }}>#JoinTheResistance</div>
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  } catch {
    return new Response(`Failed to generate image`, { status: 500 });
  }
}