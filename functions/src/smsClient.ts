import { SMS_GATEWAY_PASSWORD, SMS_GATEWAY_USERNAME } from "./config";

const SMS_GATEWAY_URL = "https://api.sms-gate.app/3rdparty/v1/message";

/**
 * Sends a text message through the SMS Gateway for Android app's Cloud API,
 * from whatever SIM is in the group's dedicated phone — the app relays the
 * send request to the device over Firebase Cloud Messaging.
 */
export async function sendMessage(phoneNumber: string, text: string): Promise<unknown> {
  const username = SMS_GATEWAY_USERNAME.value();
  const password = SMS_GATEWAY_PASSWORD.value();
  const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

  const response = await fetch(SMS_GATEWAY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify({
      textMessage: { text },
      phoneNumbers: [phoneNumber],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`SMS Gateway send failed: ${response.status} ${errorBody}`);
  }

  return response.json();
}
