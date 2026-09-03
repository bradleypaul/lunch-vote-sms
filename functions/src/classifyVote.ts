import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";
import { normalizeText } from "./voteParsing";

export interface VoteClassification {
  matchedOption: string | null;
  confidence: number;
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_vote",
  description:
    "Records which poll option (if any) a text message is voting for, and how confident that match is.",
  input_schema: {
    type: "object",
    properties: {
      matched_option: {
        type: "string",
        description:
          "The exact text of the poll option this message most likely refers to. Empty string if the message doesn't clearly express a preference among the options.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the match, from 0 (no match) to 1 (certain match).",
      },
    },
    required: ["matched_option", "confidence"],
  },
};

/**
 * Classifies a free-text SMS reply against a poll's options using Haiku,
 * grounded in each option's descriptive tags (cuisine, vibe, spice level,
 * etc.) so loose sentiment like "something spicy" can resolve to an actual
 * option instead of requiring an exact name/number match.
 *
 * The model's `matched_option` is validated against the actual options list
 * (case/punctuation-insensitive) rather than trusted verbatim — a
 * hallucinated option name is treated as no match.
 */
export async function classifyVote(
  message: string,
  options: readonly string[],
  optionTags: Record<string, string[]> = {}
): Promise<VoteClassification> {
  if (options.length === 0) {
    return { matchedOption: null, confidence: 0 };
  }

  const optionsList = options
    .map((option, i) => {
      const tags = optionTags[option];
      return tags?.length ? `${i + 1}. ${option} (${tags.join(", ")})` : `${i + 1}. ${option}`;
    })
    .join("\n");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_vote" },
    messages: [
      {
        role: "user",
        content:
          `A group member replied to a lunch poll with this text message:\n"${message}"\n\n` +
          `The poll options are:\n${optionsList}\n\n` +
          "Determine which option (if any) this message is voting for, using both literal " +
          "mentions and loose sentiment (e.g. \"something spicy\" or \"not pizza again\") " +
          "against each option's tags.",
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return { matchedOption: null, confidence: 0 };
  }

  const input = toolUse.input as { matched_option?: unknown; confidence?: unknown };
  const rawOption = typeof input.matched_option === "string" ? input.matched_option : "";
  const confidence = typeof input.confidence === "number" ? input.confidence : 0;

  const matchedOption = options.find((option) => normalizeText(option) === normalizeText(rawOption));
  if (!matchedOption) {
    return { matchedOption: null, confidence: 0 };
  }

  return { matchedOption, confidence };
}
