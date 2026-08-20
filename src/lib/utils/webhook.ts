import { createHmac } from 'crypto';

/**
 * Generates an HMAC-SHA256 signature for a given payload using a secret key.
 * @param payload - The payload to sign (usually a JSON string or an object to be stringified)
 * @param secret - The user-specific secret key
 * @returns The HMAC-SHA256 signature in hex format
 */
export function generateWebhookSignature(payload: string | object, secret: string): string {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac('sha256', secret).update(payloadString).digest('hex');
}

/**
 * Sends a webhook payload to a given URL with the X-SecureFlow-Signature header.
 * @param url - The destination URL
 * @param payload - The payload to send
 * @param secret - The user-specific secret key used to sign the payload
 * @returns The Response object from the fetch call
 */
export async function sendWebhook(url: string, payload: unknown, secret: string): Promise<Response> {
  const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = generateWebhookSignature(payloadString, secret);

  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SecureFlow-Signature': signature,
    },
    body: payloadString,
  });
}
