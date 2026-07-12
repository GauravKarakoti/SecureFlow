import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const projectName = searchParams.get('project') || 'Classified Target';

    return new ImageResponse(
      (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: '#09090b', color: '#ffffff', justifyContent: 'center', alignItems: 'center', border: '12px solid #ef4444' }}>
          <h1 style={{ fontSize: '72px', color: '#ef4444', textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: '2px', marginBottom: '10px' }}>
            BELLA CIAO
          </h1>
          <p style={{ fontSize: '32px', textAlign: 'center', maxWidth: '900px', color: '#a1a1aa', marginBottom: '40px' }}>
            &ldquo;The Royal Mint has been secured. Zero traces left behind. 🎭&rdquo;
          </p>
          <div style={{ display: 'flex', padding: '16px 32px', backgroundColor: '#ef4444', color: '#ffffff', borderRadius: '8px', fontSize: '28px', fontWeight: 'bold' }}>
            TARGET: {projectName}
          </div>
        </div>
      ),
      { width: 1200, height: 630 }
    );
  } catch {
    return new Response(`Failed to generate image`, { status: 500 });
  }
}
