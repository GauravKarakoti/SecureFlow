import { PrismaClient } from '@prisma/client';
import { HashChain } from './hashChain';
import { AuditSanitizer } from './auditSanitizer';

const prisma = new PrismaClient();

export class EventSourcingRecorder {
  static async recordEvent(action: string, payload: any): Promise<void> {
    const timestamp = new Date();
    const serializedPayload = AuditSanitizer.serializePayload(payload);

    await prisma.$transaction(async (tx) => {
      // Fetch the last event to get its hash
      const lastEvent = await tx.auditEventLedger.findFirst({
        orderBy: { sequenceNum: 'desc' },
      });

      const previousHash = lastEvent ? lastEvent.currentHash : HashChain.getGenesisHash();
      const currentHash = HashChain.calculateHash(previousHash, timestamp, action, serializedPayload);

      await tx.auditEventLedger.create({
        data: {
          action,
          payload: JSON.parse(serializedPayload), // Store as JSON but it's safe now
          timestamp,
          previousHash,
          currentHash,
        },
      });
    });
  }
}
