import { describe, expect, it } from "vitest";
import {
  normalizeStructuredCardNumber,
  normalizeStructuredSetCode,
  parseStructuredNaturalKeyQuery,
} from "./structured-natural-key-query";

describe("parseStructuredNaturalKeyQuery", () => {
  it("recognizes a set-code + collector-number query with a printed total", () => {
    expect(parseStructuredNaturalKeyQuery("SV04 123/182")).toEqual({ setCode: "sv04", cardNumber: "123" });
  });

  it("recognizes a lowercase query without a printed total", () => {
    expect(parseStructuredNaturalKeyQuery("sv04 123")).toEqual({ setCode: "sv04", cardNumber: "123" });
  });

  it("recognizes the hyphen-joined One Piece style with leading zeroes", () => {
    expect(parseStructuredNaturalKeyQuery("OP01-001")).toEqual({ setCode: "op01", cardNumber: "1" });
  });

  it("tolerates extra whitespace and mixed casing", () => {
    expect(parseStructuredNaturalKeyQuery("  Tsp   0136 ")).toEqual({ setCode: "tsp", cardNumber: "136" });
  });

  it("keeps a variant-suffixed collector number lowercase without stripping its padding (alphanumeric numbers are provider/game significant per the natural-key contract)", () => {
    expect(parseStructuredNaturalKeyQuery("swsh3 007A")).toEqual({ setCode: "swsh3", cardNumber: "007a" });
  });

  it("returns null for a query with no numeric collector-number token", () => {
    expect(parseStructuredNaturalKeyQuery("charizard")).toBeNull();
  });

  it("returns null for a bare number-number query so it is not mistaken for a natural key", () => {
    expect(parseStructuredNaturalKeyQuery("2024 12")).toBeNull();
  });

  it("returns null for an empty query", () => {
    expect(parseStructuredNaturalKeyQuery("   ")).toBeNull();
  });

  it("does not require the query to describe a real set — resolution decides that", () => {
    // Any "word number" shape parses; the read-model lookup simply returns zero
    // rows for a set code that does not exist, and callers fall back to full text.
    expect(parseStructuredNaturalKeyQuery("Pikachu 4")).toEqual({ setCode: "pikachu", cardNumber: "4" });
  });
});

describe("normalizeStructuredSetCode", () => {
  it("trims and lowercases", () => {
    expect(normalizeStructuredSetCode("  SV04  ")).toBe("sv04");
  });
});

describe("normalizeStructuredCardNumber", () => {
  it("strips leading zeroes from numeric-only values", () => {
    expect(normalizeStructuredCardNumber("0007")).toBe("7");
  });

  it("preserves alphanumeric numbers, lowercased", () => {
    expect(normalizeStructuredCardNumber("136A")).toBe("136a");
  });
});
