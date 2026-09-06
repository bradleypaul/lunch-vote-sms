import * as crypto from "crypto";

/**
 * Verifies the SMS Gateway for Android app's webhook signature:
 * hex(HMAC-SHA256(secret, rawBody + timestamp)), delivered as the
 * `X-Signature` and `X-Timestamp` headers. `rawBody` must be the exact
 * bytes of the request body — re-serializing the parsed JSON can reorder
 * keys or change whitespace and silently break verification.
 */
export function verifySmsGatewaySignature(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !timestampHeader) {
    return false;
  }

  const data = Buffer.concat([rawBody, Buffer.from(timestampHeader, "utf8")]);
  const expected = crypto.createHmac("sha256", secret).update(data).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
