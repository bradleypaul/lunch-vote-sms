import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, HAIKU_MODEL } from "./config";

export type OwnerIntent =
  | { action: "invite"; name: string | null; phoneNumber: string }
  | { action: "create_poll"; options: string[] }
  | { action: "remove_member"; who: string }
  | { action: "set_can_host"; who: string; canHost: boolean }
  | { action: "set_is_admin"; who: string; isAdmin: boolean }
  | { action: "list_members" }
  | { action: "help" };

const CLASSIFY_OWNER_INTENT_TOOL: Anthropic.Tool = {
  name: "classify_owner_intent",
  description:
    "Determines which admin action (if any) the group organizer's text message is asking for, and extracts " +
    "whatever details that action needs.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["invite", "create_poll", "remove_member", "set_can_host", "set_is_admin", "list_members", "help", "none"],
        description:
          "\"invite\" to add a new person; \"create_poll\" to start a new lunch poll with a list of options; " +
          "\"remove_member\" to delete someone from the group; \"set_can_host\" to change whether someone can " +
          "be asked to host an activity; \"set_is_admin\" to promote or demote someone as an admin (giving or " +
          "taking away access to these same admin commands); \"list_members\" to see everyone in the group; " +
          "\"help\" if they're asking what they can do; \"none\" if the message doesn't clearly ask for any of " +
          "these (e.g. it's approving/overriding a digest, which is handled elsewhere, or isn't an admin " +
          "request at all).",
      },
      invitee_name: {
        type: "string",
        description: "For \"invite\": the person's name, if mentioned. Empty string if not given.",
      },
      invitee_phone: {
        type: "string",
        description: "For \"invite\": the phone number, exactly as written in the message.",
      },
      poll_options: {
        type: "array",
        items: { type: "string" },
        description: "For \"create_poll\": each option mentioned, as separate strings.",
      },
      member_identifier: {
        type: "string",
        description: "For \"remove_member\", \"set_can_host\", or \"set_is_admin\": the name or phone number identifying the member.",
      },
      can_host: {
        type: "boolean",
        description: "For \"set_can_host\": true if they should be askable to host, false if not.",
      },
      is_admin: {
        type: "boolean",
        description: "For \"set_is_admin\": true to promote (grant admin access), false to demote (revoke it).",
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
 * Natural-language fallback for the admin commands, run only after none of
 * the exact-syntax fast-path parsers (parseInviteCommand, parsePollCommand,
 * isMembersCommand, parseRemoveCommand, parseCanHostCommand,
 * parseAdminCommand, isHelpCommand — see ownerCommandHandler) matched, and
 * after approve/override (which already has its own Haiku fallback via
 * classifyApprovalReply) didn't either. This is what lets an admin just
 * say "add Jane, her number's 512-555-1234" or "let's do a poll for
 * chipotle or panera" instead of needing exact command syntax.
 *
 * A hallucinated or incomplete action (missing the phone number an invite
 * needs, fewer than two poll options, etc.) is treated as no match rather
 * than guessed at, same validate-don't-trust-verbatim approach as the
 * other classifiers.
 */
export async function classifyOwnerIntent(message: string, confidenceThreshold: number): Promise<OwnerIntent | null> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 300,
    tools: [CLASSIFY_OWNER_INTENT_TOOL],
    tool_choice: { type: "tool", name: "classify_owner_intent" },
    messages: [
      {
        role: "user",
        content: `An admin of a lunch-poll SMS bot sent this text to the bot's admin line:\n"${message}"\n\nWhat admin action, if any, are they asking for?`,
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) {
    return null;
  }

  const input = toolUse.input as {
    action?: unknown;
    invitee_name?: unknown;
    invitee_phone?: unknown;
    poll_options?: unknown;
    member_identifier?: unknown;
    can_host?: unknown;
    is_admin?: unknown;
    confidence?: unknown;
  };

  const confidence = typeof input.confidence === "number" ? input.confidence : 0;
  if (confidence < confidenceThreshold) {
    return null;
  }

  switch (input.action) {
    case "invite": {
      const phoneNumber = typeof input.invitee_phone === "string" ? input.invitee_phone.trim() : "";
      if (!phoneNumber) {
        return null;
      }
      const name = typeof input.invitee_name === "string" && input.invitee_name.trim() ? input.invitee_name.trim() : null;
      return { action: "invite", name, phoneNumber };
    }
    case "create_poll": {
      const options = Array.isArray(input.poll_options)
        ? input.poll_options.filter((option): option is string => typeof option === "string" && option.trim().length > 0)
        : [];
      return options.length >= 2 ? { action: "create_poll", options } : null;
    }
    case "remove_member": {
      const who = typeof input.member_identifier === "string" ? input.member_identifier.trim() : "";
      return who ? { action: "remove_member", who } : null;
    }
    case "set_can_host": {
      const who = typeof input.member_identifier === "string" ? input.member_identifier.trim() : "";
      const canHost = typeof input.can_host === "boolean" ? input.can_host : null;
      return who && canHost !== null ? { action: "set_can_host", who, canHost } : null;
    }
    case "set_is_admin": {
      const who = typeof input.member_identifier === "string" ? input.member_identifier.trim() : "";
      const isAdmin = typeof input.is_admin === "boolean" ? input.is_admin : null;
      return who && isAdmin !== null ? { action: "set_is_admin", who, isAdmin } : null;
    }
    case "list_members":
      return { action: "list_members" };
    case "help":
      return { action: "help" };
    default:
      return null;
  }
}
