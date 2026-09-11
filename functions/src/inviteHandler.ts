import { COLLECTIONS, MY_PHONE_NUMBER, hashPhoneNumber } from "./config";
import { parseInviteCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

/**
 * Handles the owner's "invite <phone>" / "invite <name> <phone>" command:
 * creates a groupMembers doc with active:false and texts the invitee an
 * explanation of what this number is, asking them to reply yes to join.
 * The doc existing-but-inactive is what routes their reply to
 * handleSignupReply instead of it being silently rejected as unknown (see
 * voteWebhook.ts). Also texts the owner back a one-line confirmation of
 * what was sent to whom — the owner has no other way to see this worked
 * short of checking Cloud Logging.
 *
 * Returns whether the message was recognized as an invite command at all,
 * so voteWebhook knows not to also try treating it as an approval reply —
 * this is independent of whether either text actually sent successfully,
 * which is only logged, not surfaced to the caller.
 */
export async function handleInviteCommand(db: FirebaseFirestore.Firestore, message: string): Promise<boolean> {
  const invite = parseInviteCommand(message);
  if (!invite) {
    return false;
  }

  const phoneHash = hashPhoneNumber(invite.phoneNumber);
  await db
    .collection(COLLECTIONS.groupMembers)
    .doc(phoneHash)
    .set(
      {
        name: invite.name ?? "Invitee",
        phoneNumber: invite.phoneNumber,
        active: false,
      },
      { merge: true }
    );

  const greeting = invite.name ? `Hi ${invite.name}!` : "Hi!";
  const introText = `${greeting} This number runs a weekly lunch poll for a small group. Want in? Reply YES to join (or just ignore this if not).`;

  let sendFailed = false;
  try {
    await sendMessage(invite.phoneNumber, introText);
    console.log(`inviteHandler: invited phoneHash=${phoneHash}`);
  } catch (err) {
    sendFailed = true;
    console.error(`inviteHandler: invite send failed phoneHash=${phoneHash}`, err);
  }

  const who = invite.name ? `${invite.name} (${invite.phoneNumber})` : invite.phoneNumber;
  const confirmationText = sendFailed
    ? `Got your invite for ${who}, but the text to them failed to send — check the logs.`
    : `Invited ${who} — waiting on their reply.`;
  try {
    await sendMessage(MY_PHONE_NUMBER.value(), confirmationText);
  } catch (err) {
    console.error(`inviteHandler: owner confirmation send failed phoneHash=${phoneHash}`, err);
  }

  return true;
}
