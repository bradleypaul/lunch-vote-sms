import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";
import { ApprovalReply, normalizeText } from "./voteParsing";

const CLASSIFY_APPROVAL_TOOL: Anthropic.Tool = {
  name: "classify_approval_reply",
  description:
    "Determines whether the owner's reply approves the recommended pick, overrides it with a " +
    "different option, or doesn't clearly express either.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["approve", "override", "unclear"],
        description:
          "\"approve\" if the reply confirms the recommended option, \"override\" if it clearly " +
          "picks a different option from the list, \"unclear\" otherwise.",
      },
      option: {
        type: "string",
        description:
          "When action is \"override\", the exact text of the poll option the reply picks. " +
          "Empty string otherwise.",
      },
      confidence: {
        type: "number",
        description: "Confidence in this reading, from 0 (no idea) to 1 (certain).",
      },
    },
    required: ["action", "confidence"],
  },
};

/**
 * Fallback for approval replies that `parseApprovalReply`'s exact keyword
 * match couldn't place — free-form phrasing like "yeah let's do chipotle" or
 * "sounds good, go with that one". Only called when the deterministic parse
 * comes back null, so the common "approve" / "override <option>" case never
 * costs an API call.
 *
 * Same validation approach as `classifyVote`: the model's named option is
 * checked against the actual poll options (case/punctuation-insensitive)
 * rather than trusted verbatim, and a low-confidence or unclear read is
 * treated as no match at all — left alone, same as any other unparseable
 * text.
 */
export async function classifyApprovalReply(
  message: string,
  options: readonly string[],
  confidenceThreshold: number
): Promise<ApprovalReply | null> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    tools: [CLASSIFY_APPROVAL_TOOL],
    tool_choice: { type: "tool", name: "classify_approval_reply" },
    messages: [
      {
        role: "user",
        content:
          `The owner was texted a lunch poll digest recommending an option, and replied:\n"${message}"\n\n` +
          `The poll options are:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n\n` +
          "Does this reply approve the recommendation, override it with a specific different " +
          "option from the list, or is it unclear?",
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return null;
  }

  const input = toolUse.input as { action?: unknown; option?: unknown; confidence?: unknown };
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (confidence < confidenceThreshold) {
    return null;
  }

  if (input.action === "approve") {
    return { action: "approve" };
  }

  if (input.action === "override") {
    const rawOption = typeof input.option === "string" ? input.option : "";
    const matched = options.find((option) => normalizeText(option) === normalizeText(rawOption));
    return matched ? { action: "override", option: matched } : null;
  }

  return null;
}
