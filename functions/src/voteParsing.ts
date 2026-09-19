/**
 * Normalizes free-text SMS input for comparison: trims, lowercases, strips
 * punctuation, and collapses whitespace. Applied to both the incoming
 * message body and the poll's option strings so comparisons are symmetric.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"()\-_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses an SMS reply body against a poll's options. Accepts either a
 * 1-based numeric index ("2") or the option text itself, case-insensitive
 * and tolerant of stray punctuation ("panera!" matches "Panera").
 *
 * Returns the canonical option string from `options`, or null if the body
 * doesn't unambiguously match any option.
 */
export function parseVote(rawBody: string, options: readonly string[]): string | null {
  if (options.length === 0) {
    return null;
  }

  const trimmed = rawBody.trim();
  if (/^\d+$/.test(trimmed)) {
    const asIndex = Number(trimmed);
    if (asIndex >= 1 && asIndex <= options.length) {
      return options[asIndex - 1];
    }
    return null;
  }

  const normalized = normalizeText(rawBody);
  if (!normalized) {
    return null;
  }

  const textMatch = options.find((option) => normalizeText(option) === normalized);
  return textMatch ?? null;
}

export type ApprovalReply =
  | { action: "approve" }
  | { action: "override"; option: string };

const APPROVE_KEYWORDS = new Set(["approve", "approved", "yes", "confirm", "confirmed", "go", "lgtm", "sounds good", "yep", "yup"]);

/**
 * Parses the owner's reply to a digest into an approve/override action.
 * Deliberately simple keyword matching rather than an LLM call — per the
 * spec, this step "doesn't need much intelligence." Anything that isn't a
 * recognized approve keyword or a well-formed "override <option>" returns
 * null so the caller can just leave the message alone and wait for a
 * clearer reply.
 */
export function parseApprovalReply(rawBody: string, options: readonly string[]): ApprovalReply | null {
  const normalized = normalizeText(rawBody);
  if (APPROVE_KEYWORDS.has(normalized)) {
    return { action: "approve" };
  }

  const overrideMatch = rawBody.trim().match(/^override[:\s]+(.+)$/i);
  if (overrideMatch) {
    const matched = options.find((option) => normalizeText(option) === normalizeText(overrideMatch[1]));
    if (matched) {
      return { action: "override", option: matched };
    }
  }

  return null;
}

export type PromptReply = "yes" | "no" | "maybe";

// Keyword sets are already in normalizeText's output form (no apostrophes,
// single spaces) since normalizeText strips punctuation before comparing.
const YES_KEYWORDS = new Set(["yes", "yep", "yup", "sure", "im in", "count me in", "lets go", "sounds good"]);
const NO_KEYWORDS = new Set(["no", "nope", "cant", "cant make it", "not this time", "pass"]);
const MAYBE_KEYWORDS = new Set(["maybe", "not sure", "possibly", "tbd", "well see"]);

/**
 * Parses a reply to a yes/no/maybe prompt (e.g. "want to host?", "want to
 * go?"). Deliberately simple keyword matching as a free, instant fast path
 * — the caller falls back to an LLM classification for anything this
 * doesn't recognize (see promptReplyHandler).
 */
export function parsePromptReply(rawBody: string): PromptReply | null {
  const normalized = normalizeText(rawBody);
  if (YES_KEYWORDS.has(normalized)) {
    return "yes";
  }
  if (NO_KEYWORDS.has(normalized)) {
    return "no";
  }
  if (MAYBE_KEYWORDS.has(normalized)) {
    return "maybe";
  }
  return null;
}

export interface InviteCommand {
  name: string | null;
  phoneNumber: string;
}

// Matches a US phone number at the end of the string, tolerating the
// common ways people actually type one: bare digits, dashes, dots, a
// space-separated area code in parens ("(512) 555-1234"), and an optional
// leading country code ("+1", "1-"). Anchored to the end (allowing
// trailing whitespace) so it also marks where the name portion ends.
const TRAILING_PHONE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\s*$/;

/**
 * Parses the owner's "invite <phone>" or "invite <name> <phone>" command.
 * The phone number must be at the end of the message, in any common US
 * format (see TRAILING_PHONE) — anything before it is taken as the name.
 * The returned phoneNumber is normalized to E.164 (+1XXXXXXXXXX), not the
 * raw typed text — SMS Gateway's send API rejects punctuated numbers like
 * "(512) 555-1234", so callers need a clean value both for sending and for
 * storing consistently in Firestore.
 *
 * Returns null if the message doesn't start with "invite" or nothing at
 * the end looks like a phone number, so the caller can fall through to
 * treating it as an ordinary approval reply instead.
 */
export function parseInviteCommand(rawBody: string): InviteCommand | null {
  const match = rawBody.trim().match(/^invite\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const rest = match[1].trim();
  const phoneMatch = rest.match(TRAILING_PHONE);
  if (!phoneMatch) {
    return null;
  }

  const digits = phoneMatch[0].replace(/[^\d]/g, "");
  if (digits.length !== 10 && digits.length !== 11) {
    return null;
  }
  const phoneNumber = digits.length === 11 ? `+${digits}` : `+1${digits}`;

  const name = rest.slice(0, phoneMatch.index).trim();
  return { name: name || null, phoneNumber };
}

/** True if the message is exactly the "help" command (any case/punctuation). */
export function isHelpCommand(rawBody: string): boolean {
  return normalizeText(rawBody) === "help";
}

/** True if the message is exactly the owner's "members" command (list all group members). */
export function isMembersCommand(rawBody: string): boolean {
  return normalizeText(rawBody) === "members";
}

export interface RemoveCommand {
  who: string;
}

/**
 * Parses the owner's "remove <name or phone>" command. `who` is returned
 * as typed — the caller resolves it against groupMembers by name or phone,
 * since this parser has no access to Firestore.
 */
export function parseRemoveCommand(rawBody: string): RemoveCommand | null {
  const match = rawBody.trim().match(/^remove\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const who = match[1].trim();
  return who ? { who } : null;
}

export interface CanHostCommand {
  who: string;
  canHost: boolean;
}

/**
 * Parses the owner's "canhost <name or phone> yes|no" command, setting
 * whether that member gets asked to host a `host_needed` activity idea.
 */
export function parseCanHostCommand(rawBody: string): CanHostCommand | null {
  const match = rawBody.trim().match(/^canhost\s+(.+?)\s+(yes|no)$/i);
  if (!match) {
    return null;
  }
  const who = match[1].trim();
  if (!who) {
    return null;
  }
  return { who, canHost: match[2].toLowerCase() === "yes" };
}
