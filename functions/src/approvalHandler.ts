import { COLLECTIONS, DIGEST_DOC_ID, POLL_STATUS } from "./config";
import { parseApprovalReply } from "./voteParsing";
import { sendFinalAnnouncement } from "./sendFinalAnnouncement";

interface PollDoc {
  options: string[];
  status: string;
}

interface DigestDoc {
  recommendedOption: string | null;
}

/**
 * Handles a reply from the owner's own number. Only acts on a poll that's
 * currently awaiting_approval; anything that doesn't parse as "approve" or
 * a well-formed "override <option>" is left alone — same as any other text
 * — so the owner can just reply again with something clearer.
 */
export async function handleApproval(db: FirebaseFirestore.Firestore, message: string): Promise<void> {
  const pendingSnap = await db
    .collection(COLLECTIONS.polls)
    .where("status", "==", POLL_STATUS.awaitingApproval)
    .limit(1)
    .get();

  if (pendingSnap.empty) {
    console.log("approvalHandler: no poll awaiting approval, ignoring");
    return;
  }

  const pollDoc = pendingSnap.docs[0];
  const poll = pollDoc.data() as PollDoc;

  const reply = parseApprovalReply(message, poll.options ?? []);
  if (!reply) {
    console.log(`approvalHandler: unparseable reply pollId=${pollDoc.id}`);
    return;
  }

  let confirmedOption: string | null;
  if (reply.action === "approve") {
    const digestSnap = await pollDoc.ref.collection(COLLECTIONS.digest).doc(DIGEST_DOC_ID).get();
    const digest = digestSnap.data() as DigestDoc | undefined;
    confirmedOption = digest?.recommendedOption ?? null;
    if (!confirmedOption) {
      console.log(`approvalHandler: approve with no recommendedOption on digest pollId=${pollDoc.id}, ignoring`);
      return;
    }
  } else {
    confirmedOption = reply.option;
  }

  await pollDoc.ref.update({
    status: POLL_STATUS.approved,
    confirmedOption,
  });
  console.log(`approvalHandler: approved pollId=${pollDoc.id} option=${confirmedOption} action=${reply.action}`);

  await sendFinalAnnouncement(db, pollDoc.id, confirmedOption);
}
