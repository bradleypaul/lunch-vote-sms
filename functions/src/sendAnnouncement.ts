import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import {
  ANNOUNCEMENT_SCHEDULE,
  COLLECTIONS,
  FIRESTORE_REGION,
  POLL_STATUS,
  TIMEZONE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} from "./config";
import { sendMessage } from "./smsClient";

interface PollDoc {
  options: string[];
}

interface GroupMemberDoc {
  phoneNumber: string;
  active: boolean;
}

/**
 * Cloud Scheduler-triggered (see ANNOUNCEMENT_SCHEDULE). Requires an open
 * poll doc to already exist (seeded manually in Firestore — see README);
 * this function only sends, it doesn't create the poll. Texts every active
 * group member the current options individually.
 */
export const sendAnnouncement = onSchedule(
  {
    schedule: ANNOUNCEMENT_SCHEDULE,
    timeZone: TIMEZONE,
    region: FIRESTORE_REGION,
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN],
  },
  async () => {
    const db = admin.firestore();

    const openPollSnap = await db
      .collection(COLLECTIONS.polls)
      .where("status", "==", POLL_STATUS.open)
      .orderBy("opensAt", "desc")
      .limit(1)
      .get();

    if (openPollSnap.empty) {
      console.log("sendAnnouncement: no open poll, nothing to send");
      return;
    }

    const pollDoc = openPollSnap.docs[0];
    const poll = pollDoc.data() as PollDoc;
    const optionsText = (poll.options ?? []).map((o, i) => `${i + 1}. ${o}`).join("\n");
    const text = `Where's lunch this week? Reply with your pick:\n${optionsText}`;

    const membersSnap = await db.collection(COLLECTIONS.groupMembers).where("active", "==", true).get();

    const results = await Promise.allSettled(
      membersSnap.docs.map((memberDoc) => {
        const member = memberDoc.data() as GroupMemberDoc;
        return sendMessage(member.phoneNumber, text);
      })
    );

    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`sendAnnouncement: send failed memberId=${membersSnap.docs[i].id}`, result.reason);
      }
    });

    console.log(`sendAnnouncement: pollId=${pollDoc.id} sentTo=${membersSnap.size}`);
  }
);
