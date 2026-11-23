import { describe, expect, it } from "vitest";
import { createPolicyCache, POLICY_CACHE_MAX_AGE_MS, type PolicyDocumentCandidate } from "./cache";

const candidates: readonly PolicyDocumentCandidate[] = [
  { documentId: "pol_1", value: { holdDays: 2 }, effectiveFrom: "2026-04-30T00:00:00.000Z", effectiveUntil: null },
];

function createClockedCache(startMs = 50_000) {
  let nowMs = startMs;
  const cache = createPolicyCache({ now: () => nowMs });
  return {
    cache,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("createPolicyCache", () => {
  it("bounds a set's age at one second", () => {
    expect(POLICY_CACHE_MAX_AGE_MS).toBe(1_000);
  });

  it("returns undefined for a key that was never set, and the stored value once set", () => {
    const cache = createPolicyCache();

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.lastLoaded("settlement.clearance-window")).toBeUndefined();

    cache.set("settlement.clearance-window", candidates);

    expect(cache.get("settlement.clearance-window")).toEqual(candidates);
  });

  it("defaults its clock to Date.now and exposes the clock it was given", () => {
    const fixed = () => 123;

    expect(createPolicyCache().now).toBe(Date.now);
    expect(createPolicyCache({ now: fixed }).now).toBe(fixed);
  });

  it("misses once a set's age reaches the bound and keeps it as the last loaded set", () => {
    const { cache, advance } = createClockedCache();
    cache.set("settlement.clearance-window", candidates);

    advance(POLICY_CACHE_MAX_AGE_MS - 1);
    expect(cache.get("settlement.clearance-window")).toBe(candidates);

    advance(1);
    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.lastLoaded("settlement.clearance-window")).toEqual({ candidates, readStartedAtMs: 50_000 });

    advance(60 * 60 * 1_000);
    expect(cache.lastLoaded("settlement.clearance-window")).toEqual({ candidates, readStartedAtMs: 50_000 });
  });

  it("ages a set from the read start it was stamped with, not from when it was stored", () => {
    const { cache, advance } = createClockedCache();
    advance(400);

    cache.set("settlement.clearance-window", candidates, 50_000);

    expect(cache.lastLoaded("settlement.clearance-window")?.readStartedAtMs).toBe(50_000);
    advance(599);
    expect(cache.get("settlement.clearance-window")).toBe(candidates);
    advance(1);
    expect(cache.get("settlement.clearance-window")).toBeUndefined();
  });

  it("misses a set stamped ahead of the clock", () => {
    const { cache } = createClockedCache();

    cache.set("settlement.clearance-window", candidates, 50_001);

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.lastLoaded("settlement.clearance-window")).toEqual({ candidates, readStartedAtMs: 50_001 });
  });

  it("invalidate makes only the targeted key miss at once and keeps its last loaded set", () => {
    const { cache } = createClockedCache();
    cache.set("settlement.clearance-window", candidates);
    cache.set("settlement.payout-bounds", []);

    cache.invalidate("settlement.clearance-window");

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.lastLoaded("settlement.clearance-window")).toEqual({ candidates, readStartedAtMs: 50_000 });
    expect(cache.get("settlement.payout-bounds")).toEqual([]);
  });

  it("invalidateAll makes every key miss at once and keeps each last loaded set", () => {
    const { cache } = createClockedCache();
    cache.set("settlement.clearance-window", candidates);
    cache.set("settlement.payout-bounds", []);

    cache.invalidateAll();

    expect(cache.get("settlement.clearance-window")).toBeUndefined();
    expect(cache.get("settlement.payout-bounds")).toBeUndefined();
    expect(cache.lastLoaded("settlement.clearance-window")).toEqual({ candidates, readStartedAtMs: 50_000 });
    expect(cache.lastLoaded("settlement.payout-bounds")).toEqual({ candidates: [], readStartedAtMs: 50_000 });
  });

  it("serves a key again once it is set after an invalidation", () => {
    const { cache } = createClockedCache();
    cache.set("settlement.clearance-window", []);
    cache.invalidate("settlement.clearance-window");

    cache.set("settlement.clearance-window", candidates);

    expect(cache.get("settlement.clearance-window")).toBe(candidates);
  });

  it("invalidating a key that was never set loads nothing", () => {
    const cache = createPolicyCache();

    cache.invalidate("settlement.clearance-window");

    expect(cache.lastLoaded("settlement.clearance-window")).toBeUndefined();
  });
});
