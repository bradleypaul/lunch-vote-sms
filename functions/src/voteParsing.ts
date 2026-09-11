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

/**
 * Parses the owner's "invite <phone>" or "invite <name> <phone>" command.
 * The phone number must be the message's last word, normalizing (digits
 * only) to exactly 10 or 11 digits (a US number, with or without a leading
 * country code) — anything before it is taken as the name. Returns null if
 * the message doesn't start with "invite" or the last word isn't a
 * plausible phone number, so the caller can fall through to treating it as
 * an ordinary approval reply instead.
 */
export function parseInviteCommand(rawBody: string): InviteCommand | null {
  const match = rawBody.trim().match(/^invite\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const words = match[1].trim().split(/\s+/);
  const lastWord = words[words.length - 1];
  const digits = lastWord.replace(/[^\d]/g, "");
  if (digits.length !== 10 && digits.length !== 11) {
    return null;
  }

  const name = words.slice(0, -1).join(" ").trim();
  return { name: name || null, phoneNumber: lastWord };
}
