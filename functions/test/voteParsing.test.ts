import { describe, expect, it } from "vitest";
import { normalizeText, parseApprovalReply, parseVote } from "../src/voteParsing";

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
