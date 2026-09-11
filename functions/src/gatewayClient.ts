import { SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD } from "./config";

const API_BASE_URL = "https://api.sms-gate.app/3rdparty/v1";

interface SendMessageResponse {
  id: string;
  state: string;
}

/**
 * Sends a text message through the SMSGate cloud relay, which forwards it
 * to the registered Android device via FCM for delivery over the phone's
 * own SIM. Uses Basic Auth with the device's Cloud-mode login/password
 * (from Secret Manager), per the /3rdparty/v1 OpenAPI spec.
 */
export async function sendMessage(phoneNumber: string, text: string): Promise<SendMessageResponse> {
  const login = SMS_GATEWAY_LOGIN.value();
  const password = SMS_GATEWAY_PASSWORD.value();
  const basicAuth = Buffer.from(`${login}:${password}`).toString("base64");

  const response = await fetch(`${API_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: JSON.stringify({
      phoneNumbers: [phoneNumber],
      textMessage: { text },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`SMSGate send failed: ${response.status} ${errorBody}`);
  }

  return (await response.json()) as SendMessageResponse;
}
