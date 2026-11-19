import crypto from "k6/crypto";

/**
 * Compute the GitHub webhook HMAC-SHA256 signature for a given payload and secret.
 *
 * GitHub transmits this in the `x-hub-signature-256` header formatted as:
 * `sha256=<hex-digest>`.
 *
 * @param {string|object} payload - Raw stringified JSON request body or object
 * @param {string} secret - GitHub webhook secret
 * @returns {string} The full signature header value (sha256=...)
 */
export function computeHmacSignature(payload, secret) {
  if (!secret) {
    throw new Error("Webhook secret is required to compute HMAC signature.");
  }

  const payloadString = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hex = crypto.hmac("sha256", secret, payloadString, "hex");
  return `sha256=${hex}`;
}

export default computeHmacSignature;
