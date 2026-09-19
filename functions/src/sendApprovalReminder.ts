import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import {
  APPROVAL_REMINDER_SCHEDULE,
  COLLECTIONS,
  FIRESTORE_REGION,
  MY_PHONE_NUMBER,
  POLL_STATUS,
  SMS_GATEWAY_LOGIN,
  SMS_GATEWAY_PASSWORD,
  TIMEZONE,
} from "./config";
import { sendMessage } from "./gatewayClient";

/**
 * Cloud Scheduler-triggered (see APPROVAL_REMINDER_SCHEDULE — default
 * Friday, a day after generateDigest normally fires). If a poll is still
 * sitting in awaiting_approval — the digest went out but nobody replied
 * approve/override yet — texts the owner one more nudge, so it doesn't
 * just get lost in the thread.
 */
export const sendApprovalReminder = onSchedule(
  {
    schedule: APPROVAL_REMINDER_SCHEDULE,
    timeZone: TIMEZONE,
    region: FIRESTORE_REGION,
    secrets: [SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, MY_PHONE_NUMBER],
  },
  async () => {
    const db = admin.firestore();

    const snap = await db
      .collection(COLLECTIONS.polls)
      .where("status", "==", POLL_STATUS.awaitingApproval)
      .orderBy("opensAt", "desc")
      .limit(1)
      .get();

    if (snap.empty) {
      console.log("sendApprovalReminder: nothing awaiting approval");
      return;
    }

    const pollId = snap.docs[0].id;
    try {
      await sendMessage(
        MY_PHONE_NUMBER.value(),
        'Reminder: this week\'s lunch digest is still waiting on your "approve" or "override <option>".'
      );
      console.log(`sendApprovalReminder: reminded pollId=${pollId}`);
    } catch (err) {
      console.error(`sendApprovalReminder: send failed pollId=${pollId}`, err);
    }
  }
);
