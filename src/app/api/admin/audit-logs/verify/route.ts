import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { HashChain } from '../../../../../lib/audit/hashChain';
import { AuditSanitizer } from '../../../../../lib/audit/auditSanitizer';

const prisma = new PrismaClient();

export async function POST(request: Request) {
  try {
    const logs = await prisma.auditEventLedger.findMany({
      orderBy: { sequenceNum: 'asc' },
    });

    if (logs.length === 0) {
      return NextResponse.json({ success: true, message: 'Ledger is empty.' });
    }

    let previousHash = HashChain.getGenesisHash();
    let isIntact = true;
    let corruptedSequenceNum = -1;

    for (const log of logs) {
      if (log.previousHash !== previousHash) {
        isIntact = false;
        corruptedSequenceNum = log.sequenceNum;
        break;
      }

      const expectedCurrentHash = HashChain.calculateHash(
        previousHash,
        log.timestamp,
        log.action,
        JSON.stringify(log.payload) // Serialized payload matches exactly
      );

      if (log.currentHash !== expectedCurrentHash) {
        isIntact = false;
        corruptedSequenceNum = log.sequenceNum;
        break;
      }

      previousHash = expectedCurrentHash;
    }

    if (isIntact) {
      return NextResponse.json({
        success: true,
        message: 'Cryptographic Hash Chain is fully intact. No tampering detected.',
      });
    } else {
      return NextResponse.json(
        {
          success: false,
          error: 'INTEGRITY_VIOLATION',
          message: `Tampering detected at sequence number ${corruptedSequenceNum}.`,
        },
        { status: 403 }
      );
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
