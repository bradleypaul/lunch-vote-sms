import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifySmsGatewaySignature } from "../src/smsGatewaySignature";

const SECRET = "test-webhook-secret";

function sign(body: string, timestamp: string, secret = SECRET): string {
  const data = Buffer.concat([Buffer.from(body, "utf8"), Buffer.from(timestamp, "utf8")]);
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

describe("verifySmsGatewaySignature", () => {
  it("accepts a correctly signed request", () => {
    const body = '{"event":"sms:received","payload":{"phoneNumber":"+15125551234","message":"2"}}';
    const timestamp = "1700000000";
    const signature = sign(body, timestamp);

    expect(verifySmsGatewaySignature(Buffer.from(body, "utf8"), timestamp, signature, SECRET)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = '{"event":"sms:received","payload":{"phoneNumber":"+15125551234","message":"2"}}';
    const timestamp = "1700000000";
    const signature = sign(body, timestamp, "wrong-secret");

    expect(verifySmsGatewaySignature(Buffer.from(body, "utf8"), timestamp, signature, SECRET)).toBe(false);
  });

  it("rejects a signature computed over a different body", () => {
    const timestamp = "1700000000";
    const signature = sign('{"payload":{"message":"2"}}', timestamp);

    expect(
      verifySmsGatewaySignature(Buffer.from('{"payload":{"message":"3"}}', "utf8"), timestamp, signature, SECRET)
    ).toBe(false);
  });

  it("rejects a signature computed over a different timestamp", () => {
    const body = '{"payload":{"message":"2"}}';
    const signature = sign(body, "1700000000");

    expect(verifySmsGatewaySignature(Buffer.from(body, "utf8"), "1700000001", signature, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySmsGatewaySignature(Buffer.from("{}", "utf8"), "1700000000", undefined, SECRET)).toBe(false);
  });

  it("rejects a missing timestamp header", () => {
    const body = "{}";
    const signature = sign(body, "1700000000");

    expect(verifySmsGatewaySignature(Buffer.from(body, "utf8"), undefined, signature, SECRET)).toBe(false);
  });
});
