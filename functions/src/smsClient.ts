import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } from "./config";

interface SendMessageResponse {
  sid: string;
  status: string;
}

/**
 * Sends a text message through Twilio's Messages API from the group's
 * dedicated toll-free number.
 */
export async function sendMessage(phoneNumber: string, text: string): Promise<SendMessageResponse> {
  const accountSid = TWILIO_ACCOUNT_SID.value();
  const authToken = TWILIO_AUTH_TOKEN.value();
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const body = new URLSearchParams({
    To: phoneNumber,
    From: TWILIO_FROM_NUMBER.value(),
    Body: text,
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`Twilio send failed: ${response.status} ${errorBody}`);
  }

  return (await response.json()) as SendMessageResponse;
}
