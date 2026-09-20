import { onRequest, Request } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  ANTHROPIC_API_KEY,
  CLASSIFY_CONFIDENCE_THRESHOLD,
  COLLECTIONS,
  FIRESTORE_REGION,
  MY_PHONE_NUMBER,
  SMS_GATEWAY_LOGIN,
  SMS_GATEWAY_PASSWORD,
  WEBHOOK_SIGNING_SECRET,
  hashPhoneNumber,
  normalizePhoneDigits,
} from "./config";
import { verifyWebhookSignature } from "./webhookSignature";
import { classifyVote } from "./classifyVote";
import { classifyActivityIdea } from "./classifyActivityIdea";
import { handleApproval } from "./approvalHandler";
import { handlePromptReply } from "./promptReplyHandler";
import { handleActivityIdea } from "./activityIdeaHandler";
import { handleInviteCommand } from "./inviteHandler";
import { handleSignupReply } from "./signupHandler";
import { handleMembersCommand, handleRemoveCommand, handleCanHostCommand, handleAdminCommand } from "./memberManagementHandler";
import { handleOwnerHelpCommand, handleMemberHelpCommand } from "./helpHandler";
import { handlePollCommand } from "./pollCommandHandler";
import { handleOwnerNaturalLanguageFallback } from "./ownerCommandHandler";
import { safeClassify } from "./safeClassify";
import { findOpenPoll } from "./pollUtils";

type AdminCommandHandler = (db: FirebaseFirestore.Firestore, message: string, replyTo: string) => Promise<boolean>;

// Tried in order against any text from an admin (the root owner, or a
// member promoted via "admin <name or phone> yes"); the first one that
// recognizes the message handles it. Each of these is a free, instant
// exact-syntax match (including handleApproval's own internal fast path);
// anything none of them recognize — including looser phrasing none of
// their Haiku fallbacks caught either — falls through to
// handleOwnerNaturalLanguageFallback, one last Haiku call covering every
// other admin intent (see ownerCommandHandler.ts).
const ADMIN_COMMAND_HANDLERS: AdminCommandHandler[] = [
  handleOwnerHelpCommand,
  handleInviteCommand,
  handlePollCommand,
  handleMembersCommand,
  handleRemoveCommand,
  handleCanHostCommand,
  handleAdminCommand,
  handleApproval,
];

/**
 * Runs a message from a confirmed admin through every exact-syntax
 * command in turn, falling back to one Haiku call (classifyOwnerIntent)
 * if none of them match. Confirmations always go back to `replyTo` — the
 * admin who actually sent the message, not a fixed number — since more
 * than one person can hold admin access.
 */
async function handleAdminMessage(db: FirebaseFirestore.Firestore, message: string, replyTo: string): Promise<void> {
  for (const handler of ADMIN_COMMAND_HANDLERS) {
    if (await handler(db, message, replyTo)) {
      return;
    }
  }
  await handleOwnerNaturalLanguageFallback(db, message, replyTo);
}

interface PollDoc {
  options: string[];
  optionTags?: Record<string, string[]>;
  status: string;
}

interface GroupMemberDoc {
  active: boolean;
  isAdmin?: boolean;
  pendingPrompt?: { ideaId: string };
}

interface HttpResponse {
  status(code: number): { send(body: string): unknown };
}

/**
 * HTTPS endpoint SMS Gateway's cloud relay calls (as the `sms:received`
 * webhook) whenever a text arrives on the phone. Verifies the request,
 * then branches on sender: the root owner (`MY_PHONE_NUMBER`) and any
 * member promoted via "admin <name or phone> yes" both go through
 * `handleAdminMessage` — each admin command's exact syntax in turn (help,
 * invite, poll, members, remove, canhost, admin, approve/override), then
 * one Haiku call for anything none of those recognize, like "can you add
 * Jane, her number's 512-555-1234" (see ownerCommandHandler.ts); a pending
 * (invited but not yet active) member's texts are read as a yes/no signup
 * answer; and an active, non-admin member's texts try each interpretation
 * in order — "help", an answer to a pending host/outing prompt, a vote
 * against an open poll, or a new activity-idea proposal.
 *
 * Every rejection/no-match path (bad signature, unknown sender,
 * low-confidence classification) returns 2xx/4xx with a distinct,
 * greppable log line instead of throwing — an uncaught error here would
 * surface as a 500 and likely trigger relay retries for a request that
 * will never succeed. There's no automated reply to the group by design
 * (see README) — a non-match just stays an ordinary text in the owner's
 * inbox.
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
      await handleAdminMessage(db, message, sender);
      res.status(200).send("ok");
      return;
    }

    const phoneHash = hashPhoneNumber(sender);
    const memberRef = db.collection(COLLECTIONS.groupMembers).doc(phoneHash);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists) {
      console.log(`voteWebhook: rejected, unknown sender phoneHash=${phoneHash}`);
      res.status(200).send("unknown sender");
      return;
    }

    const member = memberSnap.data() as GroupMemberDoc;
    if (!member.active) {
      await handleSignupReply(db, phoneHash, message);
      res.status(200).send("ok");
      return;
    }

    if (member.isAdmin) {
      await handleAdminMessage(db, message, sender);
      res.status(200).send("ok");
      return;
    }

    if (await handleMemberHelpCommand(sender, message)) {
      res.status(200).send("ok");
      return;
    }

    if (member.pendingPrompt) {
      await handlePromptReply(db, phoneHash, member.pendingPrompt, message);
      res.status(200).send("ok");
      return;
    }

    const pollDoc = await findOpenPoll(db);
    if (pollDoc) {
      const poll = pollDoc.data() as PollDoc;
      const classification = await safeClassify(
        `voteWebhook classifyVote pollId=${pollDoc.id} phoneHash=${phoneHash}`,
        { matchedOption: null, confidence: 0 },
        () => classifyVote(message, poll.options ?? [], poll.optionTags ?? {})
      );
      if (classification.matchedOption && classification.confidence >= CLASSIFY_CONFIDENCE_THRESHOLD) {
        await recordVote(pollDoc, phoneHash, classification.matchedOption, classification.confidence, message);
        console.log(
          `voteWebhook: recorded vote pollId=${pollDoc.id} phoneHash=${phoneHash} choice=${classification.matchedOption} confidence=${classification.confidence}`
        );
        res.status(200).send("ok");
        return;
      }
    }

    const idea = await safeClassify(
      `voteWebhook classifyActivityIdea phoneHash=${phoneHash}`,
      { isIdea: false, kind: null, activity: "", confidence: 0 },
      () => classifyActivityIdea(message)
    );
    if (idea.isIdea && idea.kind && idea.confidence >= CLASSIFY_CONFIDENCE_THRESHOLD) {
      await handleActivityIdea(db, phoneHash, { kind: idea.kind, activity: idea.activity });
      console.log(`voteWebhook: activity idea phoneHash=${phoneHash} kind=${idea.kind} confidence=${idea.confidence}`);
      res.status(200).send("ok");
      return;
    }

    console.log(`voteWebhook: no match phoneHash=${phoneHash}`);
    res.status(200).send("no match");
  }
);

interface SmsReceivedWebhookBody {
  event: string;
  payload: {
    message: string;
    sender: string;
  };
}

function parseInboundSms(
  req: Request,
  res: HttpResponse
): { sender: string; message: string } | null {
  if (req.method !== "POST") {
    res.status(405).send("method not allowed");
    return null;
  }

  const rawBody = req.rawBody?.toString("utf8") ?? "";
  const timestampHeader = req.header("X-Timestamp");
  const signatureValid = verifyWebhookSignature(rawBody, req.header("X-Signature"), timestampHeader, WEBHOOK_SIGNING_SECRET.value());
  if (!signatureValid) {
    const timestamp = Number(timestampHeader);
    const ageSeconds = Number.isFinite(timestamp) ? Math.round(Date.now() / 1000 - timestamp) : "n/a";
    console.error(
      `voteWebhook: rejected, invalid or missing webhook signature (hasSignature=${!!req.header("X-Signature")} hasTimestamp=${!!timestampHeader} ageSeconds=${ageSeconds})`
    );
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
    receivedAt: FieldValue.serverTimestamp(),
    rawBody,
  });
}
