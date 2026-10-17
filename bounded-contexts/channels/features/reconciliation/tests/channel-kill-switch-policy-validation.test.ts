import { describe, expect, it } from "vitest";
import {
  CHANNEL_RECONCILIATION_POLICY_FALLBACK,
  decodeChannelOutboundKillSwitchPolicy,
  decodeChannelReconciliationPolicy,
} from "../domain/policy";

describe("channel-kill-switch-policy-validation", () => {
  it("claimed-snapshot-age-policy preserves exact legacy overrides and validates the closed new shape", () => {
    const legacy = {
      cadenceMs: 60_001,
      saleLookbackMs: 3_600_001,
      backdatingAttentionAfterMs: 0,
      gapPersistenceRuns: 4,
      maxListingsPerRun: 6,
      maxSaleLinesPerRun: 7,
      attentionListingLimit: 8,
    };
    expect(CHANNEL_RECONCILIATION_POLICY_FALLBACK.snapshotMaxAgeMs).toBe(86_400_000);
    expect(decodeChannelReconciliationPolicy(legacy)).toEqual({ ...legacy, snapshotMaxAgeMs: 86_400_000 });
    for (const snapshotMaxAgeMs of [1, 86_400_000, 7_776_000_000])
      expect(decodeChannelReconciliationPolicy({ ...legacy, snapshotMaxAgeMs })).toEqual({
        ...legacy,
        snapshotMaxAgeMs,
      });
    for (const snapshotMaxAgeMs of [
      0,
      -1,
      1.5,
      7_776_000_001,
      Number.MAX_SAFE_INTEGER + 1,
      NaN,
      Infinity,
      "86400000",
      null,
    ])
      expect(() => decodeChannelReconciliationPolicy({ ...legacy, snapshotMaxAgeMs })).toThrow(/snapshotMaxAgeMs/);
    expect(() => decodeChannelReconciliationPolicy({ ...legacy, unknown: 1 })).toThrow(/exactly/);
    expect(() => decodeChannelReconciliationPolicy({ ...legacy, snapshotMaxAgeMs: 1, unknown: 1 })).toThrow(/exactly/);
    for (const key of Object.keys(legacy)) {
      const missing = Object.fromEntries(Object.entries(legacy).filter(([name]) => name !== key));
      expect(() => decodeChannelReconciliationPolicy(missing)).toThrow(/exactly/);
      expect(() => decodeChannelReconciliationPolicy({ ...missing, snapshotMaxAgeMs: 1 })).toThrow(/exactly/);
    }
  });
  it("accepts only a recursively closed, bounded and canonical kill switch", () => {
    expect(
      decodeChannelOutboundKillSwitchPolicy({
        heldProviderKeys: ["ebay", "tcgplayer"],
        heldConnectionIds: ["connection-a", "connection-b"],
      }),
    ).toEqual({
      heldProviderKeys: ["ebay", "tcgplayer"],
      heldConnectionIds: ["connection-a", "connection-b"],
    });
    expect(() =>
      decodeChannelOutboundKillSwitchPolicy({
        heldProviderKeys: ["tcgplayer", "ebay"],
        heldConnectionIds: [],
      }),
    ).toThrow(/unique and ascending/);
    expect(() =>
      decodeChannelOutboundKillSwitchPolicy({
        heldProviderKeys: ["ebay"],
        heldConnectionIds: [],
        malformed: true,
      } as never),
    ).toThrow(/exactly/);
  });

  it("rejects mixed valid and malformed reconciliation policy values", () => {
    expect(() =>
      decodeChannelReconciliationPolicy({
        cadenceMs: 900_000,
        saleLookbackMs: 86_400_000,
        backdatingAttentionAfterMs: 21_600_000,
        gapPersistenceRuns: 3,
        maxListingsPerRun: 5_000,
        maxSaleLinesPerRun: "5000",
        attentionListingLimit: 100,
      } as never),
    ).toThrow(/maxSaleLinesPerRun/);
  });
});
