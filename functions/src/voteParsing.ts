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
