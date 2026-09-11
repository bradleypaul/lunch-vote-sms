import { FieldValue } from "firebase-admin/firestore";
import { COLLECTIONS, IDEA_STATUS } from "./config";
import { sendMessage } from "./gatewayClient";
import { ActivityIdeaKind } from "./classifyActivityIdea";

interface GroupMemberDoc {
  phoneNumber: string;
  active: boolean;
  canHost?: boolean;
}

/**
 * Creates an activity-idea doc for a confident classifyActivityIdea match
 * and fans out an anonymized ask to the relevant members: everyone flagged
 * canHost for a "host_needed" idea, or every other active member for an
 * "outing". The proposer's identity never goes out in the text — only
 * their hashed phone number is stored on the idea doc, same
 * debugging-only, never-exposed-outbound treatment votes already get (see
 * README "Design note on phone numbers").
 *
 * Each targeted member gets a pendingPrompt on their groupMembers doc so
 * their next reply is read as answering this question (see
 * promptReplyHandler) instead of being treated as a vote or a new idea.
 */
export async function handleActivityIdea(
  db: FirebaseFirestore.Firestore,
  proposerPhoneHash: string,
  classification: { kind: ActivityIdeaKind; activity: string }
): Promise<void> {
  const ideaRef = db.collection(COLLECTIONS.activityIdeas).doc();
  await ideaRef.set({
    kind: classification.kind,
    activity: classification.activity,
    proposerPhoneHash,
    createdAt: FieldValue.serverTimestamp(),
    status: IDEA_STATUS.collecting,
  });

  const targetsSnap =
    classification.kind === "host_needed"
      ? await db
          .collection(COLLECTIONS.groupMembers)
          .where("active", "==", true)
          .where("canHost", "==", true)
          .get()
      : await db.collection(COLLECTIONS.groupMembers).where("active", "==", true).get();

  const targets = targetsSnap.docs.filter((doc) => doc.id !== proposerPhoneHash);

  const question =
    classification.kind === "host_needed"
      ? `Someone suggested ${classification.activity} — want to host?`
      : `Someone suggested going to ${classification.activity} — want to go?`;

  const results = await Promise.allSettled(
    targets.map(async (memberDoc) => {
      const member = memberDoc.data() as GroupMemberDoc;
      await memberDoc.ref.update({ pendingPrompt: { ideaId: ideaRef.id } });
      await sendMessage(member.phoneNumber, question);
    })
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`activityIdeaHandler: prompt failed ideaId=${ideaRef.id} memberId=${targets[i].id}`, result.reason);
    }
  });

  console.log(
    `activityIdeaHandler: ideaId=${ideaRef.id} kind=${classification.kind} activity="${classification.activity}" targeted=${targets.length}`
  );
}
