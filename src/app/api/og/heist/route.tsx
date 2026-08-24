import { ImageResponse } from 'next/og';
import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit, TIERS } from '@/lib/middleware/rate-limit';

// Node.js runtime (not edge): the IP rate limiter is backed by the redis
// (ioredis) client, which is not available in the edge runtime.
export const runtime = 'nodejs';

async function loadFontBuffer(req: NextRequest, fontFileName: string, relativePath: string): Promise<ArrayBuffer> {
  try {
    const originUrl = new URL(`/fonts/${fontFileName}`, req.url);
    const res = await fetch(originUrl.href);
    if (res && res.ok !== false) {
      return await res.arrayBuffer();
    }
  } catch {
    // continue to next fallback
  }

  try {
    const localUrl = new URL(relativePath, import.meta.url);
    const res = await fetch(localUrl);
    if (res && res.ok !== false) {
      return await res.arrayBuffer();
    }
  } catch {
    // continue to next fallback
  }

  const cdnUrl = fontFileName.includes('Bold')
    ? 'https://fonts.gstatic.com/s/orbitron/v31/yDirect4mAydbld1e65bvq8.ttf'
    : 'https://fonts.gstatic.com/s/orbitron/v31/yDirect4mAydbld1e65dqv248s.ttf';
  const cdnRes = await fetch(cdnUrl);
  if (!cdnRes || cdnRes.ok === false) {
    throw new Error(`Failed to load font ${fontFileName}`);
  }
  return await cdnRes.arrayBuffer();
}

async function handleGet(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    const [regular, bold] = await Promise.all([
      loadFontBuffer(req, 'Orbitron-Regular.ttf', '../../../../../public/fonts/Orbitron-Regular.ttf'),
      loadFontBuffer(req, 'Orbitron-Bold.ttf', '../../../../../public/fonts/Orbitron-Bold.ttf'),
    ]);

    const project = (
      searchParams.get('project') || 'Classified Target'
    )
      .trim()
      .slice(0, 60);

    const alias = (
      searchParams.get('alias') || 'The Professor'
    )
      .trim()
      .slice(0, 30);

    const rawScore = Number(searchParams.get('score') ?? 100);

    const scoreNum = Math.max(
      0,
      Math.min(100, Number.isNaN(rawScore) ? 100 : rawScore)
    );
    const score = scoreNum.toString();

    const rawRank = searchParams.get('rank')?.trim().toUpperCase();
    const validRanks = new Set(['S', 'A', 'B', 'C', 'D']);
    const rank = rawRank && validRanks.has(rawRank) ? rawRank : undefined;

    const rawFindings = searchParams.get('findingsCount') ?? searchParams.get('findings');
    const findingsCount =
      rawFindings !== null && rawFindings !== undefined && !Number.isNaN(Number(rawFindings))
        ? Math.max(0, Number(rawFindings)).toString()
        : undefined;

    const rawStolen = searchParams.get('stolen') ?? searchParams.get('amount');
    const stolen = rawStolen ? rawStolen.trim().slice(0, 30) : undefined;

    const themeParam = searchParams.get('theme')?.toLowerCase() || 'heist';
    const isGlitchTheme = themeParam === 'glitch' || themeParam === 'matrix';

    const borderColor = isGlitchTheme ? '#22c55e' : '#dc2626';
    const accentColor = isGlitchTheme ? '#22c55e' : '#ef4444';
    const bgGradient = isGlitchTheme
      ? 'linear-gradient(135deg, #021a0c 0%, #09090b 45%, #3f0d12 100%)'
      : 'linear-gradient(135deg, #09090b 0%, #18181b 45%, #3f0d12 100%)';
    const bannerText = isGlitchTheme
      ? 'SYSTEM GLITCH // TRANSMISSION ACTIVE'
      : 'INCOMING TRANSMISSION...';

    const timestamp =
      searchParams.get('timestamp') ||
      new Date().toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '56px',
            color: '#ffffff',
            background: bgGradient,
            border: `10px solid ${borderColor}`,
            fontFamily: 'Orbitron'
          }}
        >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <span
                style={{
                  color: '#ef4444',
                  fontSize: 24,
                  fontWeight: 700,
                  letterSpacing: 8,
                  textTransform: 'uppercase',
                }}
              >
                SECUREFLOW
              </span>

              {/* INCOMING TRANSMISSION... banner */}
              <div
                style={{
                  marginTop: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  backgroundColor: '#000000',
                  border: `1px solid ${accentColor}`,
                  padding: '6px 16px',
                  borderRadius: 4,
                  width: 'fit-content',
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    backgroundColor: accentColor,
                  }}
                />
                <span
                  style={{
                    color: accentColor,
                    fontSize: 16,
                    fontWeight: 700,
                    letterSpacing: 4,
                    textTransform: 'uppercase',
                  }}
                >
                  {bannerText}
                </span>
              </div>

              <span
                style={{
                  marginTop: 16,
                  fontSize: 74,
                  fontWeight: 700,
                  color: '#ffffff',
                }}
              >
                BELLA CIAO
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
              }}
            >
              {rank && (
                <div
                  style={{
                    display: 'flex',
                    padding: '10px 20px',
                    borderRadius: 8,
                    background: 'rgba(239, 68, 68, 0.2)',
                    border: '2px solid #ef4444',
                    color: '#ffffff',
                    fontSize: 22,
                    fontWeight: 700,
                    letterSpacing: 2,
                  }}
                >
                  {`RANK ${rank}`}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  padding: '14px 28px',
                  borderRadius: 9999,
                  background: '#ef4444',
                  color: '#ffffff',
                  fontSize: 24,
                  fontWeight: 700,
                }}
              >
                {alias}
              </div>
            </div>
          </div>

          {/* Project */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span
              style={{
                color: '#a1a1aa',
                fontSize: 26,
                letterSpacing: 2,
                marginBottom: 12,
              }}
            >
              TARGET
            </span>

            <span
              style={{
                color: '#ffffff',
                fontSize: 52,
                fontWeight: 700,
                lineHeight: 1.2,
              }}
            >
              {project}
            </span>
          </div>

          {/* Footer */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <span
                style={{
                  color: '#ef4444',
                  fontSize: 22,
                  fontWeight: 700,
                }}
              >
                Security Score
              </span>

              <span
                style={{
                  color: '#22c55e',
                  fontSize: 86,
                  fontWeight: 700,
                }}
              >
                {score}
              </span>
            </div>

            {(findingsCount !== undefined || stolen) && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                {findingsCount !== undefined && (
                  <span
                    style={{
                      color: '#a1a1aa',
                      fontSize: 22,
                    }}
                  >
                    Findings Logged: <span style={{ color: '#ffffff', fontWeight: 700 }}>{findingsCount}</span>
                  </span>
                )}
                {stolen && (
                  <span
                    style={{
                      color: '#f59e0b',
                      fontSize: 22,
                      fontWeight: 700,
                    }}
                  >
                    Stolen: {stolen}
                  </span>
                )}
              </div>
            )}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
              }}
            >
              <span
                style={{
                  color: '#a1a1aa',
                  fontSize: 20,
                }}
              >
                Operation Timestamp
              </span>

              <span
                style={{
                  color: '#ffffff',
                  fontSize: 24,
                  marginTop: 8,
                }}
              >
                {timestamp}
              </span>
            </div>
          </div>
        </div>
      ) as React.ReactElement,
      {
        width: 1200,
        height: 630,
         fonts: [
           {
             name: 'Orbitron',
             data: regular,
             weight: 400,
             style: 'normal',
           },
           {
            name: 'Orbitron',
             data: bold,
             weight: 700,
             style: 'normal',
           },
         ],
        headers: {
          'Cache-Control':
            'public, max-age=31536000, immutable',
        },
      }
    );
  } catch (error) {
    console.error(error);

    // Never cache the error path: a transient failure (e.g. a font-CDN blip)
    // must not be frozen by CDNs/browsers for a year. Only successful 200s above
    // carry the immutable cache header.
    return new Response('Failed to generate image', {
      status: 500,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }
}

// Public, unauthenticated route that fetches remote fonts and renders an image:
// rate-limit by IP so it can't be hammered to exhaust CPU (client-ip.ts even
// names /api/og/heist as the canonical example of a route that must be limited).
export const GET = withRateLimit(
  handleGet as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: 'og:heist:ip' }
) as typeof handleGet;
