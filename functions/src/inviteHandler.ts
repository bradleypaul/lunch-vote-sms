import { COLLECTIONS, hashPhoneNumber, normalizePhoneDigits } from "./config";
import { parseInviteCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

/**
 * Normalizes a phone number to E.164 (+1XXXXXXXXXX). Idempotent — an
 * already-normalized number passes through unchanged. `createInvite` runs
 * every phone number through this regardless of source, since the fast-path
 * parser (parseInviteCommand) already normalizes but the natural-language
 * fallback's Haiku-extracted number might not (see ownerCommandHandler).
 */
function toE164(rawPhoneNumber: string): string | null {
  const digits = normalizePhoneDigits(rawPhoneNumber);
  if (digits.length === 11) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  return null;
}

/**
 * Creates a groupMembers doc with active:false and texts the invitee an
 * explanation of what this number is, asking them to reply yes to join.
 * The doc existing-but-inactive is what routes their reply to
 * handleSignupReply instead of it being silently rejected as unknown (see
 * voteWebhook.ts). Also texts `replyTo` (the admin who issued this) back a
 * one-line confirmation of what was sent to whom — otherwise the only way
 * to see this worked is checking Cloud Logging.
 *
 * Shared by the fast-path "invite <phone>" parser and the natural-language
 * fallback ("can you add Jane, her number's 512-555-1234") — both just
 * extract a name/phone and hand off here.
 */
export async function createInvite(
  db: FirebaseFirestore.Firestore,
  name: string | null,
  rawPhoneNumber: string,
  replyTo: string
): Promise<void> {
  const phoneNumber = toE164(rawPhoneNumber);
  if (!phoneNumber) {
    console.log(`inviteHandler: rejected, unusable phone number "${rawPhoneNumber}"`);
    try {
      await sendMessage(replyTo, `Couldn't make sense of the phone number "${rawPhoneNumber}" — try again?`);
    } catch (err) {
      console.error("inviteHandler: bad-number notice send failed", err);
    }
    return;
  }

  const phoneHash = hashPhoneNumber(phoneNumber);
  await db
    .collection(COLLECTIONS.groupMembers)
    .doc(phoneHash)
    .set(
      {
        name: name ?? "Invitee",
        phoneNumber,
        active: false,
      },
      { merge: true }
    );

  const greeting = name ? `Hi ${name}!` : "Hi!";
  const introText = `${greeting} This number runs a weekly lunch poll for a small group. Want in? Reply YES to join (or just ignore this if not).`;

  let sendFailed = false;
  try {
    await sendMessage(phoneNumber, introText);
    console.log(`inviteHandler: invited phoneHash=${phoneHash}`);
  } catch (err) {
    sendFailed = true;
    console.error(`inviteHandler: invite send failed phoneHash=${phoneHash}`, err);
  }

  const who = name ? `${name} (${phoneNumber})` : phoneNumber;
  const confirmationText = sendFailed
    ? `Got your invite for ${who}, but the text to them failed to send — check the logs.`
    : `Invited ${who} — waiting on their reply.`;
  try {
    await sendMessage(replyTo, confirmationText);
  } catch (err) {
    console.error(`inviteHandler: confirmation send failed phoneHash=${phoneHash}`, err);
  }
}

/**
 * Fast path: handles an admin's exact "invite <phone>" / "invite <name>
 * <phone>" syntax, free and instant. Returns whether the message matched
 * this syntax at all, so voteWebhook's admin command chain knows whether
 * to keep trying other interpretations.
 */
export async function handleInviteCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  const invite = parseInviteCommand(message);
  if (!invite) {
    return false;
  }

  await createInvite(db, invite.name, invite.phoneNumber, replyTo);
  return true;
}
