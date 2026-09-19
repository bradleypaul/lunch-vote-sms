import { MY_PHONE_NUMBER } from "./config";
import { isHelpCommand } from "./voteParsing";
import { sendMessage } from "./gatewayClient";

const OWNER_HELP_TEXT = `Admin commands:
- invite <name>? <phone> — invite someone to the group
- approve — confirm the digest's recommended pick
- override <option> — pick a different option than recommended
- members — list all group members and their status
- remove <name or phone> — remove a member
- canhost <name or phone> yes|no — set who gets asked to host an activity idea
- help — show this message`;

const MEMBER_HELP_TEXT = `You're in the lunch poll group! Here's what you can do:
- Reply to the weekly poll with a number or the restaurant name
- Text something like "let's have a game night, who can host?" or "let's go to Emerald Tavern" any time to propose an activity
- If asked "want to host?" or "want to go?", just reply yes, no, or maybe
- Text "help" any time to see this again`;

/**
 * Handles a "help" text from the owner: texts back the admin command
 * list. Returns whether the message was recognized as this command at
 * all, so the caller knows not to also try it as an invite/approval reply.
 */
export async function handleOwnerHelpCommand(_db: FirebaseFirestore.Firestore, message: string): Promise<boolean> {
  if (!isHelpCommand(message)) {
    return false;
  }

  try {
    await sendMessage(MY_PHONE_NUMBER.value(), OWNER_HELP_TEXT);
  } catch (err) {
    console.error("helpHandler: owner help send failed", err);
  }

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
