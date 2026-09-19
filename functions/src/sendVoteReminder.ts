import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { COLLECTIONS, FIRESTORE_REGION, SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, TIMEZONE, VOTE_REMINDER_SCHEDULE } from "./config";
import { sendMessage } from "./gatewayClient";
import { findOpenPoll } from "./pollUtils";

interface PollDoc {
  options: string[];
}

interface GroupMemberDoc {
  phoneNumber: string;
  active: boolean;
}

/**
 * Cloud Scheduler-triggered (see VOTE_REMINDER_SCHEDULE — default
 * Wednesday, between Monday's announcement and Thursday's digest). Texts
 * every active member who hasn't voted on the currently open poll yet, so
 * silence before the digest generates isn't just assumed as "no opinion"
 * — everyone gets one nudge before the window closes.
 */
export const sendVoteReminder = onSchedule(
  {
    schedule: VOTE_REMINDER_SCHEDULE,
    timeZone: TIMEZONE,
    region: FIRESTORE_REGION,
    secrets: [SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD],
  },
  async () => {
    const db = admin.firestore();

    const pollDoc = await findOpenPoll(db);
    if (!pollDoc) {
      console.log("sendVoteReminder: no open poll, nothing to do");
      return;
    }

    const poll = pollDoc.data() as PollDoc;
    const optionsText = (poll.options ?? []).map((option, i) => `${i + 1}. ${option}`).join("\n");
    const text = `Reminder: haven't heard your pick for lunch yet. Reply with your vote:\n${optionsText}`;

    const votesSnap = await pollDoc.ref.collection(COLLECTIONS.votes).get();
    const votedHashes = new Set(votesSnap.docs.map((doc) => doc.id));

    const membersSnap = await db.collection(COLLECTIONS.groupMembers).where("active", "==", true).get();
    const nonVoters = membersSnap.docs.filter((doc) => !votedHashes.has(doc.id));

    const results = await Promise.allSettled(
      nonVoters.map((doc) => sendMessage((doc.data() as GroupMemberDoc).phoneNumber, text))
    );

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`sendVoteReminder: send failed memberId=${nonVoters[i].id}`, result.reason);
      }
    });

    console.log(`sendVoteReminder: pollId=${pollDoc.id} remindersSent=${nonVoters.length}`);
  }
);
