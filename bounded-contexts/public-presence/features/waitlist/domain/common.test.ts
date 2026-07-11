import { describe, expect, it } from "vitest";
import { WAITLIST_COUNTER_DISPLAY_BUCKET, roundDownWaitlistCounterForDisplay } from "./common";

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
