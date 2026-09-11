import { FieldValue } from "firebase-admin/firestore";
import { CLASSIFY_CONFIDENCE_THRESHOLD, COLLECTIONS } from "./config";
import { parsePromptReply, PromptReply } from "./voteParsing";
import { classifyPromptReply } from "./classifyPromptReply";
import { safeClassify } from "./safeClassify";
import { ActivityIdeaKind } from "./classifyActivityIdea";

interface PendingPrompt {
  ideaId: string;
}

interface ActivityIdeaDoc {
  kind: ActivityIdeaKind;
  activity: string;
}

/**
 * Handles a reply from someone with a pending host/outing prompt. The
 * exact-keyword parse ("yes" / "no" / "maybe") is tried first since it's
 * free and instant; anything looser falls back to a Haiku classification,
 * same two-tier approach as approvalHandler. The prompt is cleared either
 * way — an unparseable reply shouldn't leave someone permanently stuck
 * answering an old question instead of voting or proposing something new;
 * they can just be asked again if it matters.
 */
export async function handlePromptReply(
  db: FirebaseFirestore.Firestore,
  phoneHash: string,
  pendingPrompt: PendingPrompt,
  message: string
): Promise<void> {
  const memberRef = db.collection(COLLECTIONS.groupMembers).doc(phoneHash);
  const ideaRef = db.collection(COLLECTIONS.activityIdeas).doc(pendingPrompt.ideaId);
  const ideaSnap = await ideaRef.get();

  await memberRef.update({ pendingPrompt: FieldValue.delete() });

  if (!ideaSnap.exists) {
    console.log(`promptReplyHandler: idea ${pendingPrompt.ideaId} no longer exists, dropping reply`);
    return;
  }

  const idea = ideaSnap.data() as ActivityIdeaDoc;
  const question =
    idea.kind === "host_needed"
      ? `Someone suggested ${idea.activity} — want to host?`
      : `Someone suggested going to ${idea.activity} — want to go?`;

  const reply: PromptReply | null =
    parsePromptReply(message) ??
    (await safeClassify(`promptReplyHandler ideaId=${pendingPrompt.ideaId} phoneHash=${phoneHash}`, null, () =>
      classifyPromptReply(message, question, CLASSIFY_CONFIDENCE_THRESHOLD)
    ));

  if (!reply) {
    console.log(`promptReplyHandler: unparseable reply ideaId=${pendingPrompt.ideaId} phoneHash=${phoneHash}`);
    return;
  }

  await ideaRef.collection(COLLECTIONS.responses).doc(phoneHash).set({
    response: reply,
    receivedAt: FieldValue.serverTimestamp(),
  });
  console.log(
    `promptReplyHandler: recorded response ideaId=${pendingPrompt.ideaId} phoneHash=${phoneHash} response=${reply}`
  );
}
