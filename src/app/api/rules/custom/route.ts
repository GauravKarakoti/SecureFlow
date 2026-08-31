import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { validateRegexPattern } from '@/lib/armor/custom-rules-engine';

/**
 * GET /api/rules/custom
 * Fetches custom rules for the authenticated user.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rules = await prisma.customRule.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' }
    });

    return NextResponse.json({ rules });
  } catch (error) {
    console.error('[CUSTOM_RULES_GET]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/rules/custom
 * Creates a new custom regex rule after validation.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { name, description, regexPattern } = body;

    if (!name || !regexPattern) {
      return NextResponse.json({ error: 'Name and regexPattern are required' }, { status: 400 });
    }

    if (!validateRegexPattern(regexPattern)) {
      return NextResponse.json({ error: 'Invalid regular expression pattern' }, { status: 400 });
    }

    const rule = await prisma.customRule.create({
      data: {
        userId: session.user.id,
        name,
        description: description || '',
        regexPattern
      }
    });

    return NextResponse.json({ success: true, rule }, { status: 201 });
  } catch (error) {
    console.error('[CUSTOM_RULES_POST]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
