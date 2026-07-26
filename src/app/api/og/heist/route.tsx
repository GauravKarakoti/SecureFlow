import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

const regularFont = fetch(
  new URL('../../../../assets/fonts/Orbitron-Regular.ttf', import.meta.url)
).then((res) => res.arrayBuffer());

const boldFont = fetch(
  new URL('../../../../assets/fonts/Orbitron-Bold.ttf', import.meta.url)
).then((res) => res.arrayBuffer());

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

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

    const timestamp =
      searchParams.get('timestamp') ||
      new Date().toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

    const [regular, bold] = await Promise.all([
      regularFont,
      boldFont,
    ]);

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
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
            background:
              'linear-gradient(135deg, #09090b 0%, #18181b 45%, #3f0d12 100%)',
            border: '10px solid #dc2626',
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
      ),
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

    return new Response('Failed to generate image', {
      status: 500,
      headers: {
        'Cache-Control':
          'public, max-age=31536000, immutable',
      },
    });
  }
}
