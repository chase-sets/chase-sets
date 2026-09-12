import { describe, expect, it } from "vitest";
import { decodeChannelOutboundKillSwitchPolicy, decodeChannelReconciliationPolicy } from "../domain/policy";

describe("channel-kill-switch-policy-validation", () => {
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
