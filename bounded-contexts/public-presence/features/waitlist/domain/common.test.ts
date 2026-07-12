import { describe, expect, it } from "vitest";
import {
  WAITLIST_COUNTER_DISPLAY_BUCKET,
  normalizeWaitlistGames,
  normalizeWaitlistInventorySize,
  normalizeWaitlistStoreUrl,
  roundDownWaitlistCounterForDisplay,
} from "./common";

describe("roundDownWaitlistCounterForDisplay", () => {
  it("hides the counter below the first clean bucket", () => {
    expect(roundDownWaitlistCounterForDisplay(0)).toBeNull();
    expect(roundDownWaitlistCounterForDisplay(1)).toBeNull();
    expect(roundDownWaitlistCounterForDisplay(WAITLIST_COUNTER_DISPLAY_BUCKET - 1)).toBeNull();
  });

  it("rounds down to the nearest clean bucket once the threshold is met", () => {
    expect(roundDownWaitlistCounterForDisplay(WAITLIST_COUNTER_DISPLAY_BUCKET)).toBe(WAITLIST_COUNTER_DISPLAY_BUCKET);
    expect(roundDownWaitlistCounterForDisplay(49)).toBe(25);
    expect(roundDownWaitlistCounterForDisplay(50)).toBe(50);
    expect(roundDownWaitlistCounterForDisplay(127)).toBe(125);
    expect(roundDownWaitlistCounterForDisplay(1999)).toBe(1975);
  });
});

describe("normalizeWaitlistGames", () => {
  it("dedupes, sorts, and drops unrecognized games", () => {
    expect(normalizeWaitlistGames(["yu-gi-oh", "pokemon", "pokemon", "not-a-game"])).toEqual(["pokemon", "yu-gi-oh"]);
  });

  it("returns an empty array for undefined or null input", () => {
    expect(normalizeWaitlistGames(undefined)).toEqual([]);
    expect(normalizeWaitlistGames(null)).toEqual([]);
    expect(normalizeWaitlistGames([])).toEqual([]);
  });
});

describe("normalizeWaitlistInventorySize", () => {
  it("accepts a recognized bucket", () => {
    expect(normalizeWaitlistInventorySize("500_to_2000")).toBe("500_to_2000");
  });

  it("treats an unrecognized or missing bucket as absent", () => {
    expect(normalizeWaitlistInventorySize("not-a-bucket")).toBeNull();
    expect(normalizeWaitlistInventorySize(null)).toBeNull();
    expect(normalizeWaitlistInventorySize(undefined)).toBeNull();
  });
});

describe("normalizeWaitlistStoreUrl", () => {
  it("keeps a well-formed URL only when hasStoreLink is true", () => {
    expect(normalizeWaitlistStoreUrl(true, "https://example.com/shop")).toBe("https://example.com/shop");
    expect(normalizeWaitlistStoreUrl(false, "https://example.com/shop")).toBeNull();
  });

  it("drops a malformed URL even when hasStoreLink is true", () => {
    expect(normalizeWaitlistStoreUrl(true, "not a url")).toBeNull();
    expect(normalizeWaitlistStoreUrl(true, "ftp://example.com")).toBeNull();
  });

  it("treats a missing URL as absent", () => {
    expect(normalizeWaitlistStoreUrl(true, null)).toBeNull();
    expect(normalizeWaitlistStoreUrl(true, undefined)).toBeNull();
  });
});
