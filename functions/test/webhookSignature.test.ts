import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhookSignature";

const SECRET = "test-signing-secret";

function sign(body: string, timestamp: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(body + timestamp).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed, fresh request", () => {
    const body = JSON.stringify({ event: "sms:received" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, timestamp);

    expect(verifyWebhookSignature(body, signature, timestamp, SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = "{}";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(body, timestamp, "wrong-secret");

    expect(verifyWebhookSignature(body, signature, timestamp, SECRET)).toBe(false);
  });

  it("rejects a signature computed over a different body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign("{\"a\":1}", timestamp);

    expect(verifyWebhookSignature("{\"a\":2}", signature, timestamp, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp outside the allowed window", () => {
    const body = "{}";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
    const signature = sign(body, staleTimestamp);

    expect(verifyWebhookSignature(body, signature, staleTimestamp, SECRET, 300)).toBe(false);
  });

  it("rejects a missing signature or timestamp header", () => {
    expect(verifyWebhookSignature("{}", undefined, "123", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "abc", undefined, SECRET)).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(verifyWebhookSignature("{}", "abc", "not-a-number", SECRET)).toBe(false);
  });
});
