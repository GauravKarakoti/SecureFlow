import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import { upsertOrgPolicy, resolveEffectivePolicies } from '@/lib/policies/org-policy-engine';
import { Severity } from '@prisma/client';

/**
 * GET /api/policies/organization
 * Fetches organization policies or resolved effective policies for a repo.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get('orgId');
    const repoId = searchParams.get('repoId');

    if (repoId) {
      // Return resolved effective policies for a specific repository
      const policies = await resolveEffectivePolicies(repoId, orgId || undefined);
      return NextResponse.json({ policies });
    }

    if (!orgId) {
      return NextResponse.json({ error: 'orgId or repoId is required' }, { status: 400 });
    }

    // Return all policies for the organization
    const policies = await prisma.orgPolicy.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' }
    });

    return NextResponse.json({ policies });
  } catch (error) {
    console.error('[ORG_POLICY_GET]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/policies/organization
 * Creates or updates an organization-level security policy.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { orgId, name, description, severity, isEnabled } = body;

    if (!orgId || !name || !severity) {
      return NextResponse.json({ error: 'Missing required fields: orgId, name, severity' }, { status: 400 });
    }

    const policy = await upsertOrgPolicy(orgId, name, description || '', severity as Severity, isEnabled ?? true);

    return NextResponse.json({ success: true, policy }, { status: 201 });
  } catch (error) {
    console.error('[ORG_POLICY_POST]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
