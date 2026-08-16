import { NextResponse } from 'next/server';
import { HmacSigner } from './hmacSigner';

export async function validateWebhookRequest(request: Request) {
  const signature = request.headers.get('X-SecureFlow-Signature');
  const timestampStr = request.headers.get('X-SecureFlow-Timestamp');
  
  if (!signature || !timestampStr) {
    return NextResponse.json({ error: 'Missing signature or timestamp' }, { status: 401 });
  }

  const timestamp = parseInt(timestampStr, 10);
  
  // Need to clone request to read body multiple times if necessary
  const clonedReq = request.clone();
  const rawBody = await clonedReq.text();
  
  const signer = new HmacSigner();
  const isValid = signer.verifySignature(rawBody, signature, timestamp);

  if (!isValid) {
    return NextResponse.json({ error: 'Invalid webhook signature or replay attack detected' }, { status: 403 });
  }

  return null; // Valid request
}
