import { describe, expect, it } from "vitest";
import { createPolicyCache } from "./cache";

describe("createPolicyCache", () => {
  it("returns undefined for a key that was never set, and the stored value once set", () => {
    const cache = createPolicyCache();

    expect(cache.get("settlement.clearance-window")).toBeUndefined();

    const candidates = [
      { documentId: "pol_1", value: { holdDays: 2 }, effectiveFrom: "2026-04-30T00:00:00.000Z", effectiveUntil: null },
    ];
    cache.set("settlement.clearance-window", candidates);

    expect(cache.get("settlement.clearance-window")).toEqual(candidates);
  });

  it("invalidate removes only the targeted key", () => {
    const cache = createPolicyCache();
    cache.set("settlement.clearance-window", []);
    cache.set("settlement.payout-bounds", []);

    cache.invalidate("settlement.clearance-window");

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.get("settlement.payout-bounds")).toEqual([]);
  });

  it("invalidateAll clears every key", () => {
    const cache = createPolicyCache();
    cache.set("settlement.clearance-window", []);
    cache.set("settlement.payout-bounds", []);

    cache.invalidateAll();

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.get("settlement.payout-bounds")).toBeUndefined();
  });
});
