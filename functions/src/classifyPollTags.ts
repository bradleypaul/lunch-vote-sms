import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";

const GENERATE_TAGS_TOOL: Anthropic.Tool = {
  name: "generate_option_tags",
  description: "Generates a few short descriptive tags for each lunch option, for matching loose sentiment against them later.",
  input_schema: {
    type: "object",
    properties: {
      tags: {
        type: "object",
        description: "Map of each option's exact text to an array of 2-4 short descriptive tags (cuisine, vibe, spice level, etc.).",
        additionalProperties: { type: "array", items: { type: "string" } },
      },
    },
    required: ["tags"],
  },
};

/**
 * Generates descriptive tags for a set of poll options via Haiku, so a
 * poll created through the "poll <option>, ..." command still supports
 * loose-sentiment vote matching ("something spicy") the same way a
 * manually-seeded poll's optionTags do — see classifyVote.
 *
 * Only tags for options actually in the input list are kept; a
 * hallucinated or missing key is silently dropped rather than trusted, the
 * same validate-don't-trust-verbatim approach as the other classifiers.
 * Called through safeClassify by the caller, so a failure here just means
 * the poll gets created with no tags rather than blocking creation.
 */
export async function generateOptionTags(options: string[]): Promise<Record<string, string[]>> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    tools: [GENERATE_TAGS_TOOL],
    tool_choice: { type: "tool", name: "generate_option_tags" },
    messages: [
      {
        role: "user",
        content:
          "Generate a few short descriptive tags (cuisine, vibe, spice level, etc.) for each of these lunch " +
          "options, to help match loose text replies like \"something spicy\" or \"nothing too heavy\" against " +
          `the right option later:\n${options.map((option) => `- ${option}`).join("\n")}`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return {};
  }

  const input = toolUse.input as { tags?: unknown };
  const rawTags = input.tags && typeof input.tags === "object" ? (input.tags as Record<string, unknown>) : {};

  const tags: Record<string, string[]> = {};
  for (const option of options) {
    const value = rawTags[option];
    if (Array.isArray(value)) {
      const stringTags = value.filter((tag): tag is string => typeof tag === "string");
      if (stringTags.length > 0) {
        tags[option] = stringTags;
      }
    }
  }
  return tags;
}
