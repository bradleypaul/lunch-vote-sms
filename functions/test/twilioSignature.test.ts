import * as crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyTwilioSignature } from "../src/twilioSignature";

const AUTH_TOKEN = "test-auth-token";
const URL = "https://us-central1-lunch-vote-sms.cloudfunctions.net/voteWebhook";

function sign(url: string, params: Record<string, string>, authToken = AUTH_TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

describe("verifyTwilioSignature", () => {
  it("accepts a correctly signed request", () => {
    const params = { From: "+15125551234", To: "+15125555678", Body: "2" };
    const signature = sign(URL, params);

    expect(verifyTwilioSignature(URL, params, signature, AUTH_TOKEN)).toBe(true);
  });

  it("is order-independent over the param object (sorts internally)", () => {
    const params = { Body: "2", To: "+15125555678", From: "+15125551234" };
    const signature = sign(URL, { From: "+15125551234", To: "+15125555678", Body: "2" });

    expect(verifyTwilioSignature(URL, params, signature, AUTH_TOKEN)).toBe(true);
  });

  it("rejects a signature computed with the wrong auth token", () => {
    const params = { From: "+15125551234", Body: "2" };
    const signature = sign(URL, params, "wrong-token");

    expect(verifyTwilioSignature(URL, params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a signature computed over a different URL", () => {
    const params = { From: "+15125551234", Body: "2" };
    const signature = sign("https://evil.example.com/voteWebhook", params);

    expect(verifyTwilioSignature(URL, params, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a signature computed over different params", () => {
    const signature = sign(URL, { From: "+15125551234", Body: "2" });

    expect(verifyTwilioSignature(URL, { From: "+15125551234", Body: "3" }, signature, AUTH_TOKEN)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyTwilioSignature(URL, { Body: "2" }, undefined, AUTH_TOKEN)).toBe(false);
  });
});
