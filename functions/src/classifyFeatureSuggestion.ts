import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";

export interface FeatureSuggestionClassification {
  isSuggestion: boolean;
  suggestion: string;
  confidence: number;
}

const CLASSIFY_FEATURE_SUGGESTION_TOOL: Anthropic.Tool = {
  name: "classify_feature_suggestion",
  description: "Determines whether a text message is feedback or a feature request about the SMS bot itself, rather than an ordinary reply.",
  input_schema: {
    type: "object",
    properties: {
      is_suggestion: {
        type: "boolean",
        description:
          "True if this message is feedback, a complaint, or a feature request about how the bot itself " +
          "works (e.g. \"it'd be cool if you could also do dinner polls\" or \"can it remind me twice\"), as " +
          "opposed to a vote, an activity idea, or an ordinary reply to someone.",
      },
      suggestion: {
        type: "string",
        description: "A concise restatement of the suggestion, in the sender's own intent. Empty string if is_suggestion is false.",
      },
      confidence: {
        type: "number",
        description: "Confidence in this reading, from 0 (no idea) to 1 (certain).",
      },
    },
    required: ["is_suggestion", "confidence"],
  },
};

/**
 * Classifies a group member's free-text SMS as feedback/a feature request
 * about the bot itself, using Haiku. Run as the last fallback in
 * voteWebhook, after a message doesn't confidently match a pending
 * prompt, a vote, or an activity idea — this is deliberately the bottom
 * of the stack, not a replacement for any of those.
 */
export async function classifyFeatureSuggestion(message: string): Promise<FeatureSuggestionClassification> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    tools: [CLASSIFY_FEATURE_SUGGESTION_TOOL],
    tool_choice: { type: "tool", name: "classify_feature_suggestion" },
    messages: [
      {
        role: "user",
        content: `A group member sent this text message to a lunch-poll SMS bot's number:\n"${message}"\n\nIs this feedback or a feature request about the bot itself, rather than a vote, an activity idea, or an ordinary reply?`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return { isSuggestion: false, suggestion: "", confidence: 0 };
  }

  const input = toolUse.input as { is_suggestion?: unknown; suggestion?: unknown; confidence?: unknown };
  const suggestion = typeof input.suggestion === "string" ? input.suggestion.trim() : "";
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;

  if (input.is_suggestion !== true || !suggestion) {
    return { isSuggestion: false, suggestion: "", confidence: 0 };
  }

  return { isSuggestion: true, suggestion, confidence };
}
