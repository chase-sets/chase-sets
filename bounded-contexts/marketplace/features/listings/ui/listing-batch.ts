import type { MarketplaceListingBulkActionOutcome } from "./contracts";

export type ListingBatchIntent = "bulk-pause-listings" | "bulk-withdraw-listings";

/**
 * One bulk Listing batch (#7161 D6): one batch id, one target attempt per Listing, and a terminal vector.
 * `unknown` is the only retryable outcome; a terminal target is never sent again.
 */
export type ListingBatchVector = Readonly<{
  batchId: string;
  intent: ListingBatchIntent;
  outcomes: readonly MarketplaceListingBulkActionOutcome[];
}>;

const LISTING_BATCH_STORAGE_KEY = "chase-sets.marketplace.listing-batch.v1";

export function unknownListingBatchTargets(vector: ListingBatchVector | null): readonly string[] {
  return vector ? vector.outcomes.filter((entry) => entry.outcome === "unknown").map((entry) => entry.listingId) : [];
}

/** A retry result only replaces targets the prior vector left `unknown`; terminal targets keep their first outcome. */
export function mergeListingBatchVector(
  prior: ListingBatchVector | null,
  next: ListingBatchVector,
): ListingBatchVector {
  if (!prior || prior.batchId !== next.batchId || prior.intent !== next.intent) return next;
  const retried = new Map(next.outcomes.map((entry) => [entry.listingId, entry]));
  return {
    ...prior,
    outcomes: prior.outcomes.map((entry) =>
      entry.outcome === "unknown" ? (retried.get(entry.listingId) ?? entry) : entry,
    ),
  };
}

function isListingBatchVector(value: unknown): value is ListingBatchVector {
  if (!value || typeof value !== "object") return false;
  const vector = value as Record<string, unknown>;
  return (
    typeof vector.batchId === "string" &&
    (vector.intent === "bulk-pause-listings" || vector.intent === "bulk-withdraw-listings") &&
    Array.isArray(vector.outcomes) &&
    vector.outcomes.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).listingId === "string" &&
        ["succeeded", "conflict", "error", "unknown"].includes(String((entry as Record<string, unknown>).outcome)),
    )
  );
}

/** The retained vector survives a reload in this tab; it holds Listing ids and outcomes only. */
export function readStoredListingBatch(storage: Pick<Storage, "getItem"> | null): ListingBatchVector | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(LISTING_BATCH_STORAGE_KEY) ?? "null");
    return isListingBatchVector(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeListingBatch(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  vector: ListingBatchVector | null,
) {
  try {
    if (!vector || unknownListingBatchTargets(vector).length === 0) storage?.removeItem(LISTING_BATCH_STORAGE_KEY);
    else storage?.setItem(LISTING_BATCH_STORAGE_KEY, JSON.stringify(vector));
  } catch {
    // Storage is best effort; the server still replays any recorded target attempt.
  }
}
