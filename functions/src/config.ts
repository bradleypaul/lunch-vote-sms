import { defineSecret, defineString } from "firebase-functions/params";
import * as crypto from "crypto";

/**
 * Twilio account credentials (console.twilio.com), stored in Secret
 * Manager — never committed. TWILIO_AUTH_TOKEN also doubles as the key
 * used to verify inbound webhook signatures (see twilioSignature.ts).
 */
export const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
export const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");

/**
 * The Twilio toll-free number texts are sent from, in E.164 format
 * (+1XXXXXXXXXX). Not a secret — it's the public sender identity everyone
 * in the group sees.
 */
export const TWILIO_FROM_NUMBER = defineString("TWILIO_FROM_NUMBER");

/**
 * The exact public URL Twilio is configured to POST inbound messages to
 * (voteWebhook's deployed URL). Twilio's request-signature check is an
 * exact-string match against the URL it actually called, so this has to
 * match the webhook URL set in the Twilio console precisely — see README
 * "Webhook verification".
 */
export const VOTE_WEBHOOK_URL = defineString("VOTE_WEBHOOK_URL");

/**
 * Anthropic API key (console.claude.com) used for vote classification and
 * digest generation.
 */
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

/**
 * The owner's own phone number (digests are sent here; replies from this
 * number are routed to the approval flow instead of vote classification).
 * Stored in Secret Manager since it's PII.
 */
export const MY_PHONE_NUMBER = defineSecret("MY_PHONE_NUMBER");

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

/**
 * Below this, a classifyVote match is discarded rather than recorded — the
 * text is left alone as an ordinary message rather than being treated as a
 * (possibly wrong) vote.
 */
export const CLASSIFY_CONFIDENCE_THRESHOLD = 0.7;

export const FIRESTORE_REGION = "us-central1";

export const COLLECTIONS = {
  polls: "polls",
  votes: "votes",
  groupMembers: "groupMembers",
  digest: "digest",
} as const;

export const POLL_STATUS = {
  open: "open",
  awaitingApproval: "awaiting_approval",
  approved: "approved",
  sent: "sent",
} as const;

export const DIGEST_DOC_ID = "current";

/**
 * Schedules for the two Cloud Scheduler-triggered functions. Cron syntax,
 * evaluated in TIMEZONE. Edit these to match when the group's poll should
 * open and when the digest should go out for review.
 */
export const TIMEZONE = "America/New_York";
export const ANNOUNCEMENT_SCHEDULE = "0 9 * * 1"; // Monday 9:00am
export const DIGEST_SCHEDULE = "0 17 * * 4"; // Thursday 5:00pm

/**
 * Strips a phone number down to digits only, so formatting differences
 * ("+1 555-010-0123" vs "5550100123") never cause a hash mismatch or a
 * missed "is this me" comparison.
 */
export function normalizePhoneDigits(rawPhoneNumber: string): string {
  return rawPhoneNumber.replace(/[^\d]/g, "");
}

/**
 * Normalizes a phone number to E.164-ish digits-only form and hashes it.
 * Used as the doc ID / join key for votes and group members, so logs and
 * vote records never need to carry a raw phone number (see README "Design
 * note on phone numbers" for why `groupMembers` itself still does).
 */
export function hashPhoneNumber(rawPhoneNumber: string): string {
  return crypto.createHash("sha256").update(normalizePhoneDigits(rawPhoneNumber)).digest("hex");
}
