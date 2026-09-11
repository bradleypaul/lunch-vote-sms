import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import {
  COLLECTIONS,
  FIRESTORE_REGION,
  IDEA_DIGEST_CHECK_SCHEDULE,
  IDEA_DIGEST_WINDOW_HOURS,
  IDEA_STATUS,
  MY_PHONE_NUMBER,
  SMS_GATEWAY_LOGIN,
  SMS_GATEWAY_PASSWORD,
  TIMEZONE,
} from "./config";
import { sendMessage } from "./gatewayClient";
import { ActivityIdeaKind } from "./classifyActivityIdea";

interface ActivityIdeaDoc {
  kind: ActivityIdeaKind;
  activity: string;
}

interface ResponseDoc {
  response: "yes" | "no" | "maybe";
}

/**
 * Runs hourly (see IDEA_DIGEST_CHECK_SCHEDULE) rather than on generateDigest's
 * weekly cadence, since activity ideas can come in on any day. Finds ideas
 * that have been collecting responses for at least IDEA_DIGEST_WINDOW_HOURS,
 * texts you a tally, and marks them digested. A response that arrives after
 * that point is still recorded (see promptReplyHandler) but won't appear in
 * a summary that's already gone out.
 */
export const generateIdeaDigest = onSchedule(
  {
    schedule: IDEA_DIGEST_CHECK_SCHEDULE,
    timeZone: TIMEZONE,
    region: FIRESTORE_REGION,
    secrets: [SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, MY_PHONE_NUMBER],
  },
  async () => {
    const db = admin.firestore();
    const cutoff = Timestamp.fromMillis(Date.now() - IDEA_DIGEST_WINDOW_HOURS * 60 * 60 * 1000);

    const readySnap = await db
      .collection(COLLECTIONS.activityIdeas)
      .where("status", "==", IDEA_STATUS.collecting)
      .where("createdAt", "<=", cutoff)
      .get();

    if (readySnap.empty) {
      return;
    }

    for (const ideaDoc of readySnap.docs) {
      const idea = ideaDoc.data() as ActivityIdeaDoc;
      const responsesSnap = await ideaDoc.ref.collection(COLLECTIONS.responses).get();
      const responses = responsesSnap.docs.map((d) => (d.data() as ResponseDoc).response);

      const yes = responses.filter((r) => r === "yes").length;
      const no = responses.filter((r) => r === "no").length;
      const maybe = responses.filter((r) => r === "maybe").length;

      const label = idea.kind === "host_needed" ? `Host for "${idea.activity}"` : `Outing to "${idea.activity}"`;
      const text = `${label}: ${yes} yes, ${maybe} maybe, ${no} no (${responses.length} replied).`;

      try {
        await sendMessage(MY_PHONE_NUMBER.value(), text);
      } catch (err) {
        console.error(`generateIdeaDigest: send failed ideaId=${ideaDoc.id}`, err);
      }

      await ideaDoc.ref.update({ status: IDEA_STATUS.digested });
      console.log(`generateIdeaDigest: ideaId=${ideaDoc.id} yes=${yes} maybe=${maybe} no=${no}`);
    }
  }
);
