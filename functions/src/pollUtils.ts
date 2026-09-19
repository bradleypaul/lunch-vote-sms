import { COLLECTIONS, POLL_STATUS } from "./config";

/**
 * Finds the most recently opened poll still in `open` status. Shared by
 * voteWebhook (classifying an inbound vote) and sendVoteReminder (finding
 * who hasn't voted yet) — see README "Known limitations" for the
 * single-active-poll assumption this relies on.
 */
export async function findOpenPoll(
  db: FirebaseFirestore.Firestore
): Promise<FirebaseFirestore.QueryDocumentSnapshot | null> {
  const snap = await db
    .collection(COLLECTIONS.polls)
    .where("status", "==", POLL_STATUS.open)
    .orderBy("opensAt", "desc")
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}
