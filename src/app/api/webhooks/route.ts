import { NextResponse } from 'next/server';
import { validateWebhookRequest } from '../../../../lib/security/webhookGuard';

export async function POST(request: Request) {
  // Validate HMAC Signature
  const validationError = await validateWebhookRequest(request);
  if (validationError) {
    return validationError;
  }

  try {
    const payload = await request.json();
    
    // Process authentic webhook payload
    console.log('[Webhook] Received authentic payload:', payload);

    return NextResponse.json({ success: true, message: 'Webhook processed securely' });
  } catch (error) {
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
