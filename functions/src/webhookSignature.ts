import * as crypto from "crypto";

/**
 * Verifies the HMAC-SHA256 signature SMS Gateway attaches to webhook
 * deliveries: signature = hex(HMAC-SHA256(secret, rawBody + timestamp)),
 * sent as the X-Signature header, with the timestamp (unix seconds) used
 * in the signature sent as X-Timestamp. Confirmed against SMS Gateway's
 * own webhook-signing client code (PayloadSingingPlugin.kt) — the message
 * signed is the raw body string concatenated directly with the timestamp
 * string, no separator.
 *
 * `maxAgeSeconds` rejects stale/replayed deliveries whose timestamp is too
 * far from "now".
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  maxAgeSeconds = 300
): boolean {
  if (!signatureHeader || !timestampHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > maxAgeSeconds) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody + timestampHeader)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
