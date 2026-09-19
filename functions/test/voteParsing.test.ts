import { describe, expect, it } from "vitest";
import {
  isHelpCommand,
  isMembersCommand,
  normalizeText,
  parseApprovalReply,
  parseCanHostCommand,
  parseInviteCommand,
  parsePollCommand,
  parsePromptReply,
  parseRemoveCommand,
  parseVote,
} from "../src/voteParsing";

const OPTIONS = ["Chili's", "Panera", "Chipotle"];

describe("normalizeText", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeText("  Panera  ")).toBe("panera");
    expect(normalizeText("Panera Bread")).toBe("panera bread");
    expect(normalizeText("  Panera   Bread  ")).toBe("panera bread");
  });

  it("strips common punctuation", () => {
    expect(normalizeText("Chili's!")).toBe("chilis");
    expect(normalizeText("Panera.")).toBe("panera");
    expect(normalizeText("(Chipotle)")).toBe("chipotle");
  });
});

describe("parseVote", () => {
  it("matches a 1-based numeric index", () => {
    expect(parseVote("1", OPTIONS)).toBe("Chili's");
    expect(parseVote("2", OPTIONS)).toBe("Panera");
    expect(parseVote("3", OPTIONS)).toBe("Chipotle");
  });

  it("tolerates whitespace around a numeric reply", () => {
    expect(parseVote("  2  ", OPTIONS)).toBe("Panera");
  });

  it("rejects an out-of-range numeric index", () => {
    expect(parseVote("0", OPTIONS)).toBeNull();
    expect(parseVote("4", OPTIONS)).toBeNull();
    expect(parseVote("-1", OPTIONS)).toBeNull();
  });

  it("matches option text case-insensitively", () => {
    expect(parseVote("panera", OPTIONS)).toBe("Panera");
    expect(parseVote("PANERA", OPTIONS)).toBe("Panera");
    expect(parseVote("Panera", OPTIONS)).toBe("Panera");
  });

  it("tolerates stray punctuation and surrounding whitespace in text replies", () => {
    expect(parseVote("panera!", OPTIONS)).toBe("Panera");
    expect(parseVote("  panera.  ", OPTIONS)).toBe("Panera");
    expect(parseVote("chili's", OPTIONS)).toBe("Chili's");
    expect(parseVote("chilis", OPTIONS)).toBe("Chili's");
  });

  it("returns null for unparseable input", () => {
    expect(parseVote("", OPTIONS)).toBeNull();
    expect(parseVote("   ", OPTIONS)).toBeNull();
    expect(parseVote("mcdonalds", OPTIONS)).toBeNull();
    expect(parseVote("maybe panera?? idk", OPTIONS)).toBeNull();
  });

  it("returns null when the poll has no options", () => {
    expect(parseVote("1", [])).toBeNull();
  });

  it("does not treat a decimal as a valid index", () => {
    expect(parseVote("1.5", OPTIONS)).toBeNull();
  });
});

describe("parseApprovalReply", () => {
  it("recognizes approve keywords case-insensitively", () => {
    expect(parseApprovalReply("approve", OPTIONS)).toEqual({ action: "approve" });
    expect(parseApprovalReply("Yes", OPTIONS)).toEqual({ action: "approve" });
    expect(parseApprovalReply("LGTM", OPTIONS)).toEqual({ action: "approve" });
    expect(parseApprovalReply("  confirm  ", OPTIONS)).toEqual({ action: "approve" });
  });

  it("parses a well-formed override against a matching option", () => {
    expect(parseApprovalReply("override Panera", OPTIONS)).toEqual({ action: "override", option: "Panera" });
    expect(parseApprovalReply("override: panera", OPTIONS)).toEqual({ action: "override", option: "Panera" });
    expect(parseApprovalReply("Override chipotle!", OPTIONS)).toEqual({ action: "override", option: "Chipotle" });
  });

  it("returns null for an override naming an option not on the poll", () => {
    expect(parseApprovalReply("override McDonalds", OPTIONS)).toBeNull();
  });

  it("returns null for unrecognized replies", () => {
    expect(parseApprovalReply("sounds great, thanks!", OPTIONS)).toBeNull();
    expect(parseApprovalReply("", OPTIONS)).toBeNull();
    expect(parseApprovalReply("maybe", OPTIONS)).toBeNull();
  });
});

describe("parsePromptReply", () => {
  it("recognizes yes keywords case-insensitively", () => {
    expect(parsePromptReply("yes")).toBe("yes");
    expect(parsePromptReply("Yep")).toBe("yes");
    expect(parsePromptReply("  sure  ")).toBe("yes");
    expect(parsePromptReply("I'm in")).toBe("yes");
    expect(parsePromptReply("let's go!")).toBe("yes");
  });

  it("recognizes no keywords case-insensitively", () => {
    expect(parsePromptReply("no")).toBe("no");
    expect(parsePromptReply("Nope")).toBe("no");
    expect(parsePromptReply("can't make it")).toBe("no");
    expect(parsePromptReply("pass")).toBe("no");
  });

  it("recognizes maybe keywords case-insensitively", () => {
    expect(parsePromptReply("maybe")).toBe("maybe");
    expect(parsePromptReply("not sure")).toBe("maybe");
    expect(parsePromptReply("TBD")).toBe("maybe");
    expect(parsePromptReply("we'll see")).toBe("maybe");
  });

  it("returns null for unrecognized replies", () => {
    expect(parsePromptReply("what's this about?")).toBeNull();
    expect(parsePromptReply("")).toBeNull();
  });
});

describe("parseInviteCommand", () => {
  it("parses a phone number with no name, normalized to E.164", () => {
    expect(parseInviteCommand("invite 5125551234")).toEqual({ name: null, phoneNumber: "+15125551234" });
  });

  it("parses a name followed by a phone number", () => {
    expect(parseInviteCommand("invite Jane 5125551234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
  });

  it("normalizes a punctuated phone number to E.164", () => {
    expect(parseInviteCommand("invite Jane 512-555-1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite +15125551234")).toEqual({ name: null, phoneNumber: "+15125551234" });
  });

  it("normalizes a parenthesized area code with an internal space", () => {
    expect(parseInviteCommand("invite Jane (512) 555-1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite (512) 555-1234")).toEqual({ name: null, phoneNumber: "+15125551234" });
  });

  it("normalizes parens with or without a following separator", () => {
    expect(parseInviteCommand("invite Jane (512)555-1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane (512)5551234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane (512) 5551234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
  });

  it("normalizes any mix of hyphen, dot, space, or no separator between groups", () => {
    expect(parseInviteCommand("invite Jane 512-555.1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane 512 5551234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane 5125551234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
  });

  it("normalizes dot-separated and leading-country-code formats", () => {
    expect(parseInviteCommand("invite Jane 512.555.1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane 1-512-555-1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
    expect(parseInviteCommand("invite Jane +1 512-555-1234")).toEqual({ name: "Jane", phoneNumber: "+15125551234" });
  });

  it("joins a multi-word name", () => {
    expect(parseInviteCommand("invite Jane Doe 5125551234")).toEqual({ name: "Jane Doe", phoneNumber: "+15125551234" });
  });

  it("is case-insensitive on the command keyword", () => {
    expect(parseInviteCommand("Invite 5125551234")).toEqual({ name: null, phoneNumber: "+15125551234" });
  });

  it("returns null when the message doesn't start with invite", () => {
    expect(parseInviteCommand("5125551234")).toBeNull();
    expect(parseInviteCommand("approve")).toBeNull();
  });

  it("returns null when the last word isn't a plausible phone number", () => {
    expect(parseInviteCommand("invite Jane")).toBeNull();
    expect(parseInviteCommand("invite Jane 12345")).toBeNull();
  });
});

describe("isHelpCommand", () => {
  it("recognizes help case-insensitively and with stray punctuation", () => {
    expect(isHelpCommand("help")).toBe(true);
    expect(isHelpCommand("Help")).toBe(true);
    expect(isHelpCommand("HELP!")).toBe(true);
    expect(isHelpCommand("  help  ")).toBe(true);
  });

  it("returns false for anything else", () => {
    expect(isHelpCommand("help me choose")).toBe(false);
    expect(isHelpCommand("")).toBe(false);
  });
});

describe("isMembersCommand", () => {
  it("recognizes members case-insensitively", () => {
    expect(isMembersCommand("members")).toBe(true);
    expect(isMembersCommand("Members")).toBe(true);
  });

  it("returns false for anything else", () => {
    expect(isMembersCommand("member")).toBe(false);
    expect(isMembersCommand("list members")).toBe(false);
  });
});

describe("parseRemoveCommand", () => {
  it("parses a name or phone number", () => {
    expect(parseRemoveCommand("remove Jane")).toEqual({ who: "Jane" });
    expect(parseRemoveCommand("remove 5125551234")).toEqual({ who: "5125551234" });
    expect(parseRemoveCommand("remove Jane Doe")).toEqual({ who: "Jane Doe" });
  });

  it("is case-insensitive on the command keyword", () => {
    expect(parseRemoveCommand("Remove Jane")).toEqual({ who: "Jane" });
  });

  it("returns null when there's nothing to remove or no keyword", () => {
    expect(parseRemoveCommand("remove")).toBeNull();
    expect(parseRemoveCommand("remove ")).toBeNull();
    expect(parseRemoveCommand("Jane")).toBeNull();
  });
});

describe("parseCanHostCommand", () => {
  it("parses a yes/no toggle by name or phone", () => {
    expect(parseCanHostCommand("canhost Jane yes")).toEqual({ who: "Jane", canHost: true });
    expect(parseCanHostCommand("canhost Jane no")).toEqual({ who: "Jane", canHost: false });
    expect(parseCanHostCommand("canhost 5125551234 yes")).toEqual({ who: "5125551234", canHost: true });
  });

  it("is case-insensitive throughout", () => {
    expect(parseCanHostCommand("CanHost Jane YES")).toEqual({ who: "Jane", canHost: true });
  });

  it("handles a multi-word name", () => {
    expect(parseCanHostCommand("canhost Jane Doe yes")).toEqual({ who: "Jane Doe", canHost: true });
  });

  it("returns null without a trailing yes/no", () => {
    expect(parseCanHostCommand("canhost Jane")).toBeNull();
    expect(parseCanHostCommand("canhost Jane maybe")).toBeNull();
  });
});

describe("parsePollCommand", () => {
  it("parses comma-separated options", () => {
    expect(parsePollCommand("poll Chipotle, Panera, Chili's")).toEqual({
      options: ["Chipotle", "Panera", "Chili's"],
    });
  });

  it("trims whitespace around each option", () => {
    expect(parsePollCommand("poll  Chipotle ,Panera  ,  Chili's ")).toEqual({
      options: ["Chipotle", "Panera", "Chili's"],
    });
  });

  it("is case-insensitive on the command keyword", () => {
    expect(parsePollCommand("Poll Chipotle, Panera")).toEqual({ options: ["Chipotle", "Panera"] });
  });

  it("returns null with fewer than two options", () => {
    expect(parsePollCommand("poll Chipotle")).toBeNull();
    expect(parsePollCommand("poll")).toBeNull();
  });

  it("ignores empty entries from stray commas", () => {
    expect(parsePollCommand("poll Chipotle,, Panera,")).toEqual({ options: ["Chipotle", "Panera"] });
  });

  it("returns null when the message doesn't start with poll", () => {
    expect(parsePollCommand("Chipotle, Panera")).toBeNull();
  });
});
