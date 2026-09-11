import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";

export type ActivityIdeaKind = "host_needed" | "outing";

export interface ActivityIdeaClassification {
  isIdea: boolean;
  kind: ActivityIdeaKind | null;
  activity: string;
  confidence: number;
}

const CLASSIFY_IDEA_TOOL: Anthropic.Tool = {
  name: "classify_activity_idea",
  description:
    "Determines whether a text message is proposing a group activity or outing (as opposed to " +
    "an ordinary message, a lunch vote, or a reply to something else), and if so, what kind.",
  input_schema: {
    type: "object",
    properties: {
      is_idea: {
        type: "boolean",
        description: "True if this message is proposing a group activity or outing.",
      },
      kind: {
        type: "string",
        enum: ["host_needed", "outing"],
        description:
          "\"host_needed\" if the message proposes an activity that needs someone to host or " +
          "organize it (e.g. \"let's have a game night, who can host?\"). \"outing\" if it " +
          "suggests a specific place or event to go to (e.g. \"let's go to Emerald Tavern\" or " +
          "\"let's go to the Red Poppy Festival\"). Omit if is_idea is false.",
      },
      activity: {
        type: "string",
        description:
          "A short description of the proposed activity or place, e.g. \"game night\" or " +
          "\"Emerald Tavern\". Empty string if is_idea is false.",
      },
      confidence: {
        type: "number",
        description: "Confidence in this reading, from 0 (no idea) to 1 (certain).",
      },
    },
    required: ["is_idea", "confidence"],
  },
};

/**
 * Classifies a group member's free-text SMS as an activity/outing proposal
 * using Haiku, run only after a message doesn't confidently match an open
 * poll — this is the fallback branch in voteWebhook, not a replacement for
 * vote classification.
 *
 * Runs with no keyword trigger (unlike a slash-command style "idea:"
 * prefix) so natural phrasing works, but a low-confidence or malformed
 * result is treated as "not an idea" rather than guessed at — same
 * validate-don't-trust-verbatim approach as classifyVote.
 */
export async function classifyActivityIdea(message: string): Promise<ActivityIdeaClassification> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    tools: [CLASSIFY_IDEA_TOOL],
    tool_choice: { type: "tool", name: "classify_activity_idea" },
    messages: [
      {
        role: "user",
        content:
          `A group member sent this text message to a group-coordination phone number:\n"${message}"\n\n` +
          "Is this proposing a group activity or outing? If so, classify it as \"host_needed\" " +
          "(needs someone to organize/host it) or \"outing\" (a specific place or event to go " +
          "to), and extract a short activity description.",
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return { isIdea: false, kind: null, activity: "", confidence: 0 };
  }

  const input = toolUse.input as {
    is_idea?: unknown;
    kind?: unknown;
    activity?: unknown;
    confidence?: unknown;
  };
  const kind = input.kind === "host_needed" || input.kind === "outing" ? input.kind : null;
  const activity = typeof input.activity === "string" ? input.activity.trim() : "";
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;

  if (input.is_idea !== true || !kind || !activity) {
    return { isIdea: false, kind: null, activity: "", confidence: 0 };
  }

  return { isIdea: true, kind, activity, confidence };
}
