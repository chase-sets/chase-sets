import { describe, expect, it } from "vitest";
import { isGtinCandidate, normalizeGtin } from "./gtin";

describe("normalizeGtin", () => {
  it("normalizes a valid GTIN-8 to its canonical 14-digit form", () => {
    expect(normalizeGtin("30741850")).toBe("00000030741850");
  });

  it("normalizes a valid GTIN-12 (UPC-A) to its canonical 14-digit form", () => {
    expect(normalizeGtin("307418529636")).toBe("00307418529636");
  });

  it("normalizes a valid GTIN-13 (EAN-13) to its canonical 14-digit form", () => {
    expect(normalizeGtin("3074185296302")).toBe("03074185296302");
  });

  it("normalizes a valid GTIN-14 to itself", () => {
    expect(normalizeGtin("30741852963075")).toBe("30741852963075");
  });

  it("strips non-digit separators before normalizing", () => {
    expect(normalizeGtin("3074-1852-9636")).toBe(normalizeGtin("307418529636"));
  });

  it("rejects a barcode with an invalid check digit", () => {
    expect(normalizeGtin("307418529637")).toBeNull();
  });

  it("rejects lengths that are not valid GTIN forms", () => {
    expect(normalizeGtin("1234567")).toBeNull();
    expect(normalizeGtin("123456789")).toBeNull();
    expect(normalizeGtin("123456789012345")).toBeNull();
  });

  it("rejects empty, null, and undefined input", () => {
    expect(normalizeGtin("")).toBeNull();
    expect(normalizeGtin(null)).toBeNull();
    expect(normalizeGtin(undefined)).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(normalizeGtin("not-a-barcode")).toBeNull();
  });
});

describe("isGtinCandidate", () => {
  it("returns true for a valid GTIN", () => {
    expect(isGtinCandidate("307418529636")).toBe(true);
  });

  it("returns false for an invalid GTIN", () => {
    expect(isGtinCandidate("307418529637")).toBe(false);
  });
});
