import crypto from 'crypto';

export class HmacSigner {
  private secret: string;

  constructor(secret?: string) {
    this.secret = secret || process.env.WEBHOOK_SECRET || 'default_secure_secret_key';
  }

  generateSignature(payload: string, timestamp: number): string {
    const dataToSign = `${timestamp}.${payload}`;
    return crypto.createHmac('sha256', this.secret).update(dataToSign).digest('hex');
  }

  verifySignature(payload: string, signature: string, timestamp: number, toleranceMs = 300000): boolean {
    const now = Date.now();
    if (now - timestamp > toleranceMs) {
      return false; // Replay attack detected
    }
    const expectedSignature = this.generateSignature(payload, timestamp);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }
}
