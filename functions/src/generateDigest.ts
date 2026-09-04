import { onSchedule } from "firebase-functions/v2/scheduler";
import * as admin from "firebase-admin";
import Anthropic from "@anthropic-ai/sdk";
import {
  ANTHROPIC_API_KEY,
  COLLECTIONS,
  DIGEST_DOC_ID,
  DIGEST_SCHEDULE,
  FIRESTORE_REGION,
  HAIKU_MODEL,
  MY_PHONE_NUMBER,
  POLL_STATUS,
  SMS_GATEWAY_LOGIN,
  SMS_GATEWAY_PASSWORD,
  TIMEZONE,
} from "./config";
import { sendMessage } from "./gatewayClient";

interface PollDoc {
  options: string[];
  optionTags?: Record<string, string[]>;
  status: string;
}

interface VoteDoc {
  choice: string;
  confidence?: number;
  rawBody: string;
}

interface DigestSummary {
  themes: string;
  recommendedOption: string | null;
  recommendedReason: string;
}

const DIGEST_TOOL: Anthropic.Tool = {
  name: "generate_digest",
  description: "Summarizes a week's lunch votes into themes and a recommended pick.",
  input_schema: {
    type: "object",
    properties: {
      themes: {
        type: "string",
        description: "1-3 sentences on the sentiment behind the raw vote texts (cravings, aversions, etc).",
      },
      recommended_option: {
        type: "string",
        description:
          "The poll option this digest recommends, exact text matching one of the given options. Usually the top raw vote count, but pick a different one if the sentiment clearly diverges from the count (say why).",
      },
      recommended_reason: {
        type: "string",
        description: "1 sentence on why this option was recommended.",
      },
    },
    required: ["themes", "recommended_option", "recommended_reason"],
  },
};

/**
 * Cloud Scheduler-triggered (see DIGEST_SCHEDULE). Reads all votes for the
 * currently open poll, synthesizes a tally + sentiment summary + a
 * recommended pick via Haiku, writes it to polls/{id}/digest/{DIGEST_DOC_ID},
 * texts it to the owner's own number for review, and moves the poll to
 * awaiting_approval so the group announcement waits on that reply.
 */
export const generateDigest = onSchedule(
  {
    schedule: DIGEST_SCHEDULE,
    timeZone: TIMEZONE,
    region: FIRESTORE_REGION,
    secrets: [ANTHROPIC_API_KEY, SMS_GATEWAY_LOGIN, SMS_GATEWAY_PASSWORD, MY_PHONE_NUMBER],
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
      console.log("generateDigest: no open poll, nothing to do");
      return;
    }

    const pollDoc = openPollSnap.docs[0];
    const poll = pollDoc.data() as PollDoc;
    const options = poll.options ?? [];

    const votesSnap = await pollDoc.ref.collection(COLLECTIONS.votes).get();
    const votes = votesSnap.docs.map((d) => d.data() as VoteDoc);

    const tally: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
    for (const vote of votes) {
      if (vote.choice in tally) {
        tally[vote.choice] += 1;
      }
    }
    const totalVotes = votes.length;

    const summary =
      totalVotes === 0
        ? { themes: "No votes came in this week.", recommendedOption: null, recommendedReason: "No votes to go on." }
        : await summarizeVotes(options, poll.optionTags ?? {}, tally, votes);

    await pollDoc.ref.collection(COLLECTIONS.digest).doc(DIGEST_DOC_ID).set({
      tally,
      totalVotes,
      themes: summary.themes,
      recommendedOption: summary.recommendedOption,
      recommendedReason: summary.recommendedReason,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      approvalStatus: "pending",
    });

    await pollDoc.ref.update({ status: POLL_STATUS.awaitingApproval });

    const digestText = buildDigestText(tally, totalVotes, summary);
    await sendMessage(MY_PHONE_NUMBER.value(), digestText);

    console.log(
      `generateDigest: pollId=${pollDoc.id} totalVotes=${totalVotes} recommendedOption=${summary.recommendedOption}`
    );
  }
);

async function summarizeVotes(
  options: string[],
  optionTags: Record<string, string[]>,
  tally: Record<string, number>,
  votes: VoteDoc[]
): Promise<DigestSummary> {
  const optionsList = options
    .map((option) => {
      const tags = optionTags[option];
      return tags?.length ? `- ${option} (${tags.join(", ")}): ${tally[option]} vote(s)` : `- ${option}: ${tally[option]} vote(s)`;
    })
    .join("\n");

  const rawTexts = votes.map((v) => `"${v.rawBody}" -> ${v.choice}`).join("\n");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    tools: [DIGEST_TOOL],
    tool_choice: { type: "tool", name: "generate_digest" },
    messages: [
      {
        role: "user",
        content:
          `This week's lunch poll options and raw vote counts:\n${optionsList}\n\n` +
          `The raw text replies behind those counts:\n${rawTexts}\n\n` +
          "Summarize the sentiment/themes behind these votes and recommend a pick.",
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    const topOption = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { themes: "", recommendedOption: topOption, recommendedReason: "Top raw vote count." };
  }

  const input = toolUse.input as {
    themes?: unknown;
    recommended_option?: unknown;
    recommended_reason?: unknown;
  };
  const rawOption = typeof input.recommended_option === "string" ? input.recommended_option : "";
  const recommendedOption = options.find((o) => o === rawOption) ?? null;

  return {
    themes: typeof input.themes === "string" ? input.themes : "",
    recommendedOption,
    recommendedReason: typeof input.recommended_reason === "string" ? input.recommended_reason : "",
  };
}

function buildDigestText(tally: Record<string, number>, totalVotes: number, summary: DigestSummary): string {
  const tallyLines = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([option, count]) => `${option}: ${count}`)
    .join("\n");

  const lines = [
    `Lunch vote digest (${totalVotes} vote${totalVotes === 1 ? "" : "s"}):`,
    tallyLines,
  ];
  if (summary.themes) {
    lines.push(`Themes: ${summary.themes}`);
  }
  if (summary.recommendedOption) {
    lines.push(`Recommended: ${summary.recommendedOption} — ${summary.recommendedReason}`);
    lines.push('Reply "approve" to confirm, or "override <option>" to pick something else.');
  } else {
    lines.push('No clear pick — reply "override <option>" to choose one.');
  }
  return lines.join("\n\n");
}
