import * as crypto from "crypto";

/**
 * Verifies Twilio's X-Twilio-Signature header: base64(HMAC-SHA1(authToken,
 * url + sorted-and-concatenated "key" + "value" pairs from the POST
 * params)), per Twilio's documented request-validation algorithm
 * (twilio.com/docs/usage/webhooks/webhooks-security). `url` must be the
 * exact URL Twilio was configured to POST to, including scheme and host —
 * any mismatch (http vs https, trailing slash, query string) fails
 * verification even for a legitimate request.
 */
export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
  authToken: string
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}
