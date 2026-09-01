import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { parseManifestFile } from '@/lib/sbom/dependency-parser';
import { matchVulnerabilities } from '@/lib/sbom/vulnerability-matcher';
import { SbomScanResult } from '@/types/sbom';
import { v4 as uuidv4 } from 'uuid';

/**
 * POST /api/sbom/scan
 * Triggers an SBOM scan on provided manifest file contents.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { fileName, content } = body;

    if (!fileName || !content) {
      return NextResponse.json({ error: 'fileName and content are required' }, { status: 400 });
    }

    // 1. Parse dependencies
    const dependencies = parseManifestFile(content, fileName);

    // 2. Match against vulnerability database
    const vulnerabilities = matchVulnerabilities(dependencies);

    // 3. Construct result
    const result: SbomScanResult = {
      scanId: uuidv4(),
      timestamp: new Date(),
      totalDependencies: dependencies.length,
      vulnerabilities,
      status: vulnerabilities.length > 0 ? 'VULNERABLE' : 'CLEAN'
    };

    return NextResponse.json({ success: true, result }, { status: 200 });
  } catch (error) {
    console.error('[SBOM_SCAN_ERROR]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
