import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, COLLECTIONS, HAIKU_MODEL, hashPhoneNumber, normalizePhoneDigits } from "./config";
import { parseInviteCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

/**
 * Static instructions handed to Haiku for every invite text — only the
 * invitee's name varies. Asking for prose fresh each time (rather than
 * filling a template) is the point: it reads like a real text from Paul,
 * not a bot blast, while still hitting the same required beats.
 */
const INVITE_TEXT_PROMPT =
  "Write a friendly, casual text message inviting someone to join a weekly lunch poll group. " +
  "It should sound like a real person texting a friend or coworker, not a bot or marketing copy — " +
  "short, warm, natural phrasing, no corporate tone, no emoji, no exclamation-point overload. " +
  "It must: (1) say it's from Paul Bradley, who runs this lunch poll group, (2) briefly explain what " +
  "the group is — a small group that votes on where to get lunch each week, (3) ask if they want to " +
  "join, and (4) tell them to reply YES to join, and that they can ignore this text if they're not " +
  "interested. Keep it to 1-3 short sentences, suitable for a single SMS. Reply with only the message " +
  "text, nothing else — no quotes, no preamble.";

/**
 * Generates the invite intro text via Haiku from INVITE_TEXT_PROMPT, so
 * each invite reads as a fresh, natural message rather than an obviously
 * templated one. Falls back to a plain static message if the call fails,
 * so a Claude/network hiccup never blocks an invite from going out.
 */
async function generateInviteText(name: string | null): Promise<string> {
  const fallback = name
    ? `Hi ${name}! This is Paul Bradley — I run a weekly lunch poll for a small group. Want in? Reply YES to join (or ignore this if not).`
    : "Hi! This is Paul Bradley — I run a weekly lunch poll for a small group. Want in? Reply YES to join (or ignore this if not).";

  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `${INVITE_TEXT_PROMPT}\n\nThe invitee's name: ${name ?? "(not given — greet them generically)"}`,
        },
      ],
    });
    const textBlock = response.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    const text = textBlock?.text.trim();
    return text || fallback;
  } catch (err) {
    console.error("inviteHandler: invite text generation failed, using fallback", err);
    return fallback;
  }
}

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

  const introText = await generateInviteText(name);

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
