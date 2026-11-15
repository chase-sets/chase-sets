import type { BulkRepriceListingOutcome, BulkRepriceMarketplaceListingGateway } from "./runtime";
import type { BulkRepriceRowUpsert } from "../read-model/queries";

export async function applyBulkRepriceWaveUpdates(
  gateway: BulkRepriceMarketplaceListingGateway,
  batch: Parameters<BulkRepriceMarketplaceListingGateway["applyBulkListingPriceUpdates"]>[0],
): Promise<ReadonlyMap<string, BulkRepriceListingOutcome>> {
  const first = await gateway.applyBulkListingPriceUpdates(batch);
  const outcomes = new Map(first.items.map((item) => [item.listingId, item]));
  const unknownUpdates = batch.updates.filter((update) => outcomes.get(update.listingId)?.outcome === "unknown");
  if (unknownUpdates.length > 0) {
    // A rejected re-drive may also have committed; retain the explicit unknown decisions.
    const retried = await gateway
      .applyBulkListingPriceUpdates({ ...batch, updates: unknownUpdates })
      .catch(() => ({ items: [] }));
    const retriedByListingId = new Map(retried.items.map((item) => [item.listingId, item]));
    for (const update of unknownUpdates) {
      const outcome = retriedByListingId.get(update.listingId);
      if (outcome) outcomes.set(update.listingId, outcome);
    }
  }
  return outcomes;
}

export function bulkRepriceRowDecision(
  item: BulkRepriceListingOutcome | undefined,
): Pick<BulkRepriceRowUpsert, "outcome" | "errorMessage"> | null {
  if (item?.outcome === "unknown") return null;
  if (item?.outcome === "applied" || item?.outcome === "no_op") {
    return { outcome: item.outcome === "applied" ? "applied" : "unchanged", errorMessage: null };
  }
  return { outcome: "failed", errorMessage: item?.message ?? "Marketplace did not apply this price update." };
}
