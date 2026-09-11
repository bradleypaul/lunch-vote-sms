import { CLASSIFY_CONFIDENCE_THRESHOLD, COLLECTIONS } from "./config";
import { parsePromptReply } from "./voteParsing";
import { classifyPromptReply } from "./classifyPromptReply";
import { safeClassify } from "./safeClassify";

const SIGNUP_QUESTION = "Do you want to join the lunch poll group?";

/**
 * Handles a reply from someone with a pending (invited but not yet
 * active) groupMembers doc. "yes" activates them; "no" removes the invite
 * entirely so a future "invite" command can re-add them cleanly rather
 * than colliding with a doc left in some declined state. Anything else
 * (including "maybe" or an unparseable reply) leaves the invite pending —
 * same left-alone philosophy as everywhere else in this codebase — so
 * they can just reply again later.
 */
export async function handleSignupReply(
  db: FirebaseFirestore.Firestore,
  phoneHash: string,
  message: string
): Promise<void> {
  const memberRef = db.collection(COLLECTIONS.groupMembers).doc(phoneHash);

  const reply =
    parsePromptReply(message) ??
    (await safeClassify(`signupHandler phoneHash=${phoneHash}`, null, () =>
      classifyPromptReply(message, SIGNUP_QUESTION, CLASSIFY_CONFIDENCE_THRESHOLD)
    ));

  if (reply === "yes") {
    await memberRef.update({ active: true });
    console.log(`signupHandler: activated phoneHash=${phoneHash}`);
    return;
  }

  if (reply === "no") {
    await memberRef.delete();
    console.log(`signupHandler: declined, removed phoneHash=${phoneHash}`);
    return;
  }

  console.log(`signupHandler: pending, no clear answer phoneHash=${phoneHash}`);
}
