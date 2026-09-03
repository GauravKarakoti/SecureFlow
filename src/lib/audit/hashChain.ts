import crypto from 'crypto';

export class HashChain {
  /**
   * Generates a SHA-256 hash for a given audit event.
   */
  static calculateHash(
    previousHash: string,
    timestamp: Date,
    action: string,
    payloadString: string
  ): string {
    const data = `${previousHash}|${timestamp.toISOString()}|${action}|${payloadString}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Genesis hash for the start of the ledger.
   */
  static getGenesisHash(): string {
    return crypto.createHash('sha256').update('SECUREFLOW_GENESIS').digest('hex');
  }
}
