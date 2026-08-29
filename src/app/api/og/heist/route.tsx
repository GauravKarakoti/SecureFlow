import { ImageResponse } from 'next/og';
import { NextRequest, NextResponse } from 'next/server';
import { withRateLimit, TIERS } from '@/lib/middleware/rate-limit';
import { loadOrbitron } from '@/lib/og/fonts';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  cacheControlFor,
  parseHeistCardParams,
} from '@/lib/og/heist-card';

// Node.js runtime (not edge): the IP rate limiter is backed by the redis
// (ioredis) client, which is not available in the edge runtime, and the font
// loader reads `public/fonts` off local disk.
export const runtime = 'nodejs';

async function handleGet(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // Loaded from disk and cached for the life of the process. This used to be
    // two HTTP round trips per request, to an origin derived from the incoming
    // request's own Host header (#687).
    const { regular, bold } = await loadOrbitron();

    const {
      project,
      alias,
      score: scoreNumber,
      rank,
      findingsCount,
      stolen,
      theme,
      timestamp,
      timestampPinned,
    } = parseHeistCardParams(searchParams);

    const score = String(scoreNumber);
    const isGlitchTheme = theme === 'glitch';

    const borderColor = isGlitchTheme ? '#22c55e' : '#dc2626';
    const accentColor = isGlitchTheme ? '#22c55e' : '#ef4444';
    const bgGradient = isGlitchTheme
      ? 'linear-gradient(135deg, #021a0c 0%, #09090b 45%, #3f0d12 100%)'
      : 'linear-gradient(135deg, #09090b 0%, #18181b 45%, #3f0d12 100%)';
    const bannerText = isGlitchTheme
      ? 'SYSTEM GLITCH // TRANSMISSION ACTIVE'
      : 'INCOMING TRANSMISSION...';

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
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
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
          // `immutable` only when the URL pins every input. Without an explicit
          // `timestamp` the card embeds its own render time, so freezing it for
          // a year meant the first view's clock was served to every later one.
          'Cache-Control': cacheControlFor({ timestampPinned }),
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

// Public, unauthenticated route that renders an image: rate-limit by IP so it
// can't be hammered to exhaust CPU (client-ip.ts even names /api/og/heist as the
// canonical example of a route that must be limited). The limit bounds how many
// requests a caller makes; parseHeistCardParams bounds what each one costs.
export const GET = withRateLimit(
  handleGet as (req: NextRequest, ...args: unknown[]) => Promise<NextResponse>,
  { ...TIERS.STANDARD, keyPrefix: 'og:heist:ip' }
) as typeof handleGet;
