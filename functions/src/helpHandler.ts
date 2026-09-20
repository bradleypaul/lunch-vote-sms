import { isHelpCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

const OWNER_HELP_TEXT = `Admin commands (or just describe what you want in plain English — I'll figure it out):
- invite <name>? <phone> — invite someone to the group
- poll <option>, <option>, ... — start a new poll
- approve — confirm the digest's recommended pick
- override <option> — pick a different option than recommended
- members — list all group members and their status
- remove <name or phone> — remove a member
- canhost <name or phone> yes|no — set who gets asked to host an activity idea
- admin <name or phone> yes|no — promote or demote another admin
- help — show this message`;

const MEMBER_HELP_TEXT = `You're in the lunch poll group! No special format needed — just text naturally:
- Reply to the weekly poll with a number, the restaurant name, or even loose ideas like "something spicy"
- Say something like "let's have a game night, who can host?" or "let's go to Emerald Tavern" any time to propose an activity
- If asked "want to host?" or "want to go?", just reply yes, no, or maybe, however you'd naturally say it
- Text "help" any time to see this again`;

/** Texts `replyTo` (the admin who asked) the admin command list. */
export async function sendOwnerHelpText(replyTo: string): Promise<void> {
  try {
    await sendMessage(replyTo, OWNER_HELP_TEXT);
  } catch (err) {
    console.error("helpHandler: owner help send failed", err);
  }
}

/**
 * Fast path: handles a "help" text from an admin, free and instant.
 * Returns whether the message matched, so voteWebhook's admin command
 * chain knows whether to keep trying other interpretations.
 */
export async function handleOwnerHelpCommand(_db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  if (!isHelpCommand(message)) {
    return false;
  }
  await sendOwnerHelpText(replyTo);
  return true;
}

/**
 * Handles a "help" text from an active group member: texts back what
 * they can do. Checked before the pending-prompt/vote/idea branches in
 * voteWebhook so "help" always works regardless of other state, rather
 * than risking being swallowed as an unclear prompt reply.
 */
export async function handleMemberHelpCommand(sender: string, message: string): Promise<boolean> {
  if (!isHelpCommand(message)) {
    return false;
  }

  try {
    await sendMessage(sender, MEMBER_HELP_TEXT);
  } catch (err) {
    console.error("helpHandler: member help send failed", err);
  }

  return true;
}
