import { onRequest, Request } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import {
  ANTHROPIC_API_KEY,
  CLASSIFY_CONFIDENCE_THRESHOLD,
  COLLECTIONS,
  FIRESTORE_REGION,
  MY_PHONE_NUMBER,
  POLL_STATUS,
  SMS_GATEWAY_LOGIN,
  SMS_GATEWAY_PASSWORD,
  WEBHOOK_SIGNING_SECRET,
  hashPhoneNumber,
  normalizePhoneDigits,
} from "./config";
import { verifyWebhookSignature } from "./webhookSignature";
import { classifyVote } from "./classifyVote";
import { handleApproval } from "./approvalHandler";

interface PollDoc {
  options: string[];
  optionTags?: Record<string, string[]>;
  status: string;
}

interface HttpResponse {
  status(code: number): { send(body: string): unknown };
}

interface SmsReceivedWebhookBody {
  event: string;
  payload: {
    message: string;
    sender: string;
  };
}

/**
 * HTTPS endpoint SMS Gateway's cloud relay calls (as the `sms:received`
 * webhook) whenever a text arrives on the phone. Verifies the request, then
 * branches on sender: the owner's own number goes to the approval flow,
 * everyone else's reply gets classified against the open poll.
 *
 * Every rejection path (bad signature, no open poll, unknown sender,
 * low-confidence classification) returns 2xx/4xx with a distinct,
 * greppable log line instead of throwing — an uncaught error here would
 * surface as a 500 and likely trigger relay retries for a request that will
 * never succeed. There's no automated reply to the group by design (see
 * README) — a non-match just stays an ordinary text in the owner's inbox.
 */
export const voteWebhook = onRequest(
  {
    region: FIRESTORE_REGION,
    secrets: [SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, WEBHOOK_SIGNING_SECRET, ANTHROPIC_API_KEY, MY_PHONE_NUMBER],
  },
  async (req, res) => {
    const inbound = parseInboundSms(req, res);
    if (!inbound) {
      return;
    }

    const { sender, message } = inbound;
    const db = admin.firestore();

    if (normalizePhoneDigits(sender) === normalizePhoneDigits(MY_PHONE_NUMBER.value())) {
      await handleApproval(db, message);
      res.status(200).send("ok");
      return;
    }

    const phoneHash = hashPhoneNumber(sender);
    if (!(await isActiveGroupMember(db, phoneHash))) {
      console.log(`voteWebhook: rejected, unknown or inactive sender phoneHash=${phoneHash}`);
      res.status(200).send("unknown sender");
      return;
    }

    const pollDoc = await findOpenPoll(db);
    if (!pollDoc) {
      console.log(`voteWebhook: rejected, no open poll phoneHash=${phoneHash}`);
      res.status(200).send("no open poll");
      return;
    }

    const poll = pollDoc.data() as PollDoc;
    const classification = await classifyVote(message, poll.options ?? [], poll.optionTags ?? {});
    if (!classification.matchedOption || classification.confidence < CLASSIFY_CONFIDENCE_THRESHOLD) {
      console.log(
        `voteWebhook: below confidence threshold pollId=${pollDoc.id} phoneHash=${phoneHash} confidence=${classification.confidence}`
      );
      res.status(200).send("not confident enough");
      return;
    }

    await recordVote(pollDoc, phoneHash, classification.matchedOption, classification.confidence, message);
    console.log(
      `voteWebhook: recorded vote pollId=${pollDoc.id} phoneHash=${phoneHash} choice=${classification.matchedOption} confidence=${classification.confidence}`
    );
    res.status(200).send("ok");
  }
);

function parseInboundSms(
  req: Request,
  res: HttpResponse
): { sender: string; message: string } | null {
  if (req.method !== "POST") {
    res.status(405).send("method not allowed");
    return null;
  }

  const rawBody = req.rawBody?.toString("utf8") ?? "";
  const signatureValid = verifyWebhookSignature(
    rawBody,
    req.header("X-Signature"),
    req.header("X-Timestamp"),
    WEBHOOK_SIGNING_SECRET.value()
  );
  if (!signatureValid) {
    console.error("voteWebhook: rejected, invalid or missing webhook signature");
    res.status(401).send("invalid signature");
    return null;
  }

  let body: SmsReceivedWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.error("voteWebhook: rejected, malformed JSON body");
    res.status(400).send("malformed body");
    return null;
  }

  if (body.event !== "sms:received") {
    console.log(`voteWebhook: ignored, event=${body.event}`);
    res.status(200).send("ignored: not an sms:received event");
    return null;
  }

  const sender = body.payload?.sender;
  const message = body.payload?.message ?? "";
  if (!sender) {
    console.error("voteWebhook: rejected, payload missing sender");
    res.status(400).send("missing sender");
    return null;
  }

  return { sender, message };
}

async function isActiveGroupMember(
  db: FirebaseFirestore.Firestore,
  phoneHash: string
): Promise<boolean> {
  const memberSnap = await db.collection(COLLECTIONS.groupMembers).doc(phoneHash).get();
  return memberSnap.exists && memberSnap.data()?.active === true;
}

async function findOpenPoll(
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

async function recordVote(
  pollDoc: FirebaseFirestore.QueryDocumentSnapshot,
  phoneHash: string,
  choice: string,
  confidence: number,
  rawBody: string
): Promise<void> {
  await pollDoc.ref.collection(COLLECTIONS.votes).doc(phoneHash).set({
    choice,
    confidence,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    rawBody,
  });
}
