import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";
import { PromptReply } from "./voteParsing";

const CLASSIFY_PROMPT_REPLY_TOOL: Anthropic.Tool = {
  name: "classify_prompt_reply",
  description: "Determines whether a reply to a yes/no question is a yes, no, or maybe, or unclear.",
  input_schema: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        enum: ["yes", "no", "maybe", "unclear"],
      },
      confidence: {
        type: "number",
        description: "Confidence in this reading, from 0 (no idea) to 1 (certain).",
      },
    },
    required: ["answer", "confidence"],
  },
};

/**
 * Fallback for host/outing prompt replies that `parsePromptReply`'s exact
 * keyword match couldn't place — free-form phrasing like "yeah I could
 * probably swing that" or "ehh not really feeling it". Only called when
 * the deterministic parse comes back null, same two-tier approach as
 * classifyApprovalReply.
 */
export async function classifyPromptReply(
  message: string,
  question: string,
  confidenceThreshold: number
): Promise<PromptReply | null> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 100,
    tools: [CLASSIFY_PROMPT_REPLY_TOOL],
    tool_choice: { type: "tool", name: "classify_prompt_reply" },
    messages: [
      {
        role: "user",
        content: `Someone was asked: "${question}"\n\nThey replied: "${message}"\n\nIs that a yes, no, maybe, or unclear?`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return null;
  }

  const input = toolUse.input as { answer?: unknown; confidence?: unknown };
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (confidence < confidenceThreshold) {
    return null;
  }

  if (input.answer === "yes" || input.answer === "no" || input.answer === "maybe") {
    return input.answer;
  }

  return null;
}
