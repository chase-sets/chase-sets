import { describe, expect, it, vi } from "vitest";
import type { BulkRepriceListingOutcome, BulkRepriceMarketplaceListingGateway } from "./runtime";
import { applyBulkRepriceWaveUpdates, bulkRepriceRowDecision } from "./wave-outcomes";

const batch = {
  batchId: "bri_wave_same_attempt",
  updates: ["applied", "no_op", "conflict", "error", "unknown"].map((listingId) => ({
    listingId,
    priceAmount: "12.00",
    priceCurrencyCode: "USD",
    idempotencyKey: `bri_row_${listingId}`,
  })),
};
const firstItems = batch.updates.map(({ listingId }) => ({
  listingId,
  outcome: listingId as BulkRepriceListingOutcome["outcome"],
}));

describe("bulk reprice wave re-drive", () => {
  it.each(["applied", "no_op", "conflict", "error"] as const)(
    "re-drives only unknown with the same batch and attempt, then retains %s",
    async (outcome) => {
      const applyBulkListingPriceUpdates = vi
        .fn<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>()
        .mockResolvedValueOnce({ items: firstItems })
        .mockResolvedValueOnce({ items: [{ listingId: "unknown", outcome, message: "terminal result" }] });
      const result = await applyBulkRepriceWaveUpdates({ applyBulkListingPriceUpdates }, batch);

      expect(applyBulkListingPriceUpdates.mock.calls).toEqual([[batch], [{ ...batch, updates: [batch.updates[4]] }]]);
      expect([...result.values()]).toEqual([
        ...firstItems.slice(0, 4),
        { listingId: "unknown", outcome, message: "terminal result" },
      ]);
    },
  );

  it("bounds repeated unknown to one re-drive and never records it as a failed row", async () => {
    const applyBulkListingPriceUpdates = vi
      .fn<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>()
      .mockResolvedValue({ items: firstItems });
    const result = await applyBulkRepriceWaveUpdates({ applyBulkListingPriceUpdates }, batch);

    expect(applyBulkListingPriceUpdates).toHaveBeenCalledTimes(2);
    expect(bulkRepriceRowDecision(result.get("unknown"))).toBeNull();
    expect([...result.values()].map(bulkRepriceRowDecision).filter(Boolean)).toHaveLength(4);
  });

  it("does not retry terminal or missing targets", async () => {
    const applyBulkListingPriceUpdates = vi
      .fn<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>()
      .mockResolvedValue({ items: firstItems.slice(0, 4) });
    await applyBulkRepriceWaveUpdates({ applyBulkListingPriceUpdates }, batch);
    expect(applyBulkListingPriceUpdates).toHaveBeenCalledExactlyOnceWith(batch);
  });

  it("retains uncertainty if the re-drive omits its outcome", async () => {
    const applyBulkListingPriceUpdates = vi
      .fn<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>()
      .mockResolvedValueOnce({ items: firstItems })
      .mockResolvedValueOnce({ items: [] });
    const result = await applyBulkRepriceWaveUpdates({ applyBulkListingPriceUpdates }, batch);
    expect(bulkRepriceRowDecision(result.get("unknown"))).toBeNull();
  });

  it("retains known outcomes and uncertainty when the re-drive rejects", async () => {
    const applyBulkListingPriceUpdates = vi
      .fn<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>()
      .mockResolvedValueOnce({ items: firstItems })
      .mockRejectedValueOnce(new Error("Response lost after commit."));
    const result = await applyBulkRepriceWaveUpdates({ applyBulkListingPriceUpdates }, batch);
    expect([...result.values()]).toEqual(firstItems);
    expect(bulkRepriceRowDecision(result.get("unknown"))).toBeNull();
    expect(applyBulkListingPriceUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("bulk reprice row decision", () => {
  it.each([
    ["applied", { outcome: "applied", errorMessage: null }],
    ["no_op", { outcome: "unchanged", errorMessage: null }],
    ["conflict", { outcome: "failed", errorMessage: "Marketplace reason" }],
    ["error", { outcome: "failed", errorMessage: "Marketplace reason" }],
    ["unknown", null],
  ] as const)("maps %s without inventing a failure for unknown", (outcome, expected) => {
    expect(bulkRepriceRowDecision({ listingId: "lst_1", outcome, message: "Marketplace reason" })).toEqual(expected);
  });

  it("preserves the existing failure for a missing result", () => {
    expect(bulkRepriceRowDecision(undefined)).toEqual({
      outcome: "failed",
      errorMessage: "Marketplace did not apply this price update.",
    });
  });
});
