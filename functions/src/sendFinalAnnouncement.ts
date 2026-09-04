import { COLLECTIONS, POLL_STATUS } from "./config";
import { sendMessage } from "./smsClient";

interface PollDoc {
  eventDetails?: string;
}

interface GroupMemberDoc {
  phoneNumber: string;
  active: boolean;
}

/**
 * Texts every active group member the confirmed where (and, if the poll doc
 * carries an `eventDetails` string like a time, the when) and marks the
 * poll sent. Called from approvalHandler once the owner approves or
 * overrides a digest — this is the one group-facing send that happens
 * without the owner personally composing the message.
 */
export async function sendFinalAnnouncement(
  db: FirebaseFirestore.Firestore,
  pollId: string,
  confirmedOption: string
): Promise<void> {
  const pollRef = db.collection(COLLECTIONS.polls).doc(pollId);
  const pollSnap = await pollRef.get();
  const poll = pollSnap.data() as PollDoc | undefined;

  const text = poll?.eventDetails
    ? `Lunch is on! We're going to ${confirmedOption}. ${poll.eventDetails}`
    : `Lunch is on! We're going to ${confirmedOption}.`;

  const membersSnap = await db.collection(COLLECTIONS.groupMembers).where("active", "==", true).get();

  const results = await Promise.allSettled(
    membersSnap.docs.map((memberDoc) => {
      const member = memberDoc.data() as GroupMemberDoc;
      return sendMessage(member.phoneNumber, text);
    })
  );

  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`sendFinalAnnouncement: send failed memberId=${membersSnap.docs[i].id}`, result.reason);
    }
  });

  await pollRef.update({ status: POLL_STATUS.sent });
  console.log(`sendFinalAnnouncement: pollId=${pollId} option=${confirmedOption} sentTo=${membersSnap.size}`);
}
