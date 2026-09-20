import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { COLLECTIONS, POLL_STATUS } from "./config";
import { parsePollCommand } from "./voteParsing";
import { generateOptionTags } from "./classifyPollTags";
import { sendMessage } from "./gatewayClient";
import { safeClassify } from "./safeClassify";

/**
 * Creates a new `open` poll doc (with Haiku-generated optionTags,
 * best-effort) and texts `replyTo` (the admin who issued this) a
 * confirmation. This is the one place a poll gets created without touching
 * Firestore directly — `sendAnnouncement` still does the actual send to
 * the group on its own schedule, and if more than one poll ends up `open`
 * at once, `findOpenPoll` just uses the newest (see README "Known
 * limitations").
 *
 * Shared by the fast-path "poll <option>, ..." parser and the
 * natural-language fallback ("let's do a poll for chipotle, panera, or
 * chili's this week").
 */
export async function createPoll(db: FirebaseFirestore.Firestore, options: string[], replyTo: string): Promise<void> {
  const optionTags = await safeClassify("pollCommandHandler generateOptionTags", {}, () => generateOptionTags(options));

  const pollRef = db.collection(COLLECTIONS.polls).doc();
  await pollRef.set({
    options,
    optionTags,
    opensAt: FieldValue.serverTimestamp(),
    closesAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    status: POLL_STATUS.open,
  });

  const tagNote = Object.keys(optionTags).length > 0 ? " (with auto-generated tags)" : "";
  const confirmationText = `Created this week's poll${tagNote}: ${options.join(", ")}.`;
  try {
    await sendMessage(replyTo, confirmationText);
  } catch (err) {
    console.error(`pollCommandHandler: confirmation send failed pollId=${pollRef.id}`, err);
  }

  console.log(`pollCommandHandler: created pollId=${pollRef.id} options=${JSON.stringify(options)}`);
}

/**
 * Fast path: handles an admin's exact "poll <option>, <option>, ..."
 * syntax, free and instant. Returns whether the message matched this
 * syntax at all, so voteWebhook's admin command chain knows whether to
 * keep trying other interpretations.
 */
export async function handlePollCommand(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<boolean> {
  const command = parsePollCommand(message);
  if (!command) {
    return false;
  }

  await createPoll(db, command.options, replyTo);
  return true;
}
