import type { ListResponse } from "@chase-sets/http/responses";
import type { RealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";

export function applyMarketplaceListPatch<T>(
  data: ListResponse<T>,
  patch: RealtimeProjectionPatch,
  options: Readonly<{
    entity: string;
    idField: keyof T;
    /** Active list filter: an upserted row that stops matching leaves, and one that starts matching joins. */
    matches?: (item: T) => boolean;
  }>,
): ListResponse<T> {
  let next = data;

  for (const change of patch.changes) {
    if (change.entity !== options.entity) {
      continue;
    }

    const index = next.items.findIndex((item) => String(item[options.idField]) === change.id);

    if (change.op === "remove") {
      if (index === -1) {
        continue;
      }

      const items = next.items.filter((item) => item[options.idField] !== change.id);
      next = {
        ...next,
        items,
        total: Math.max(0, next.total - 1),
        count: items.length,
      };
      continue;
    }

    if (change.op !== "upsert") {
      continue;
    }

    const value = change.value as T;
    if (options.matches && !options.matches(value)) {
      if (index !== -1) {
        const items = next.items.filter((_, itemIndex) => itemIndex !== index);
        next = { ...next, items, total: Math.max(0, next.total - 1), count: items.length };
      }
      continue;
    }

    if (index === -1) {
      if (next.count < next.total) {
        continue;
      }

      const items = [value, ...next.items];
      next = {
        ...next,
        items,
        total: next.total + 1,
        count: items.length,
      };
      continue;
    }

    const items = [...next.items];
    items[index] = value;
    next = {
      ...next,
      items,
    };
  }

  return next;
}

type OfferMatchRankFields = Readonly<{
  offer_id: string;
  fill_source?: string | null;
  price_amount: string;
  quantity_requested: number;
  created_at: string;
  inventory_available_quantity?: number;
}>;

/**
 * Offer Match list snapshot. Listing Matches stay ahead of inventory Matches whatever a patch inserts or
 * replaces: Listing rows keep their order (a new one joins at the top), and inventory rows follow in the
 * server's rank, covering stock first, then higher Offer price, then the older Offer.
 */
export function applyOfferMatchListPatch<T extends OfferMatchRankFields>(
  current: ListResponse<T>,
  patch: RealtimeProjectionPatch,
): ListResponse<T> {
  const next = applyMarketplaceListPatch(current, patch, { entity: "marketplace.offerMatch", idField: "offer_id" });
  if (next === current) return current;
  const listingRows = next.items.filter((item) => item.fill_source !== "inventory");
  const inventoryRows = next.items.filter((item) => item.fill_source === "inventory").sort(compareInventoryMatches);
  return { ...next, items: [...listingRows, ...inventoryRows] };
}

function compareInventoryMatches(left: OfferMatchRankFields, right: OfferMatchRankFields) {
  const covers = (row: OfferMatchRankFields) =>
    Number((row.inventory_available_quantity ?? 0) >= row.quantity_requested);
  return (
    covers(right) - covers(left) ||
    Number(right.price_amount) - Number(left.price_amount) ||
    Date.parse(left.created_at) - Date.parse(right.created_at) ||
    (left.offer_id < right.offer_id ? -1 : left.offer_id > right.offer_id ? 1 : 0)
  );
}

/**
 * Submitted Offers list snapshot: rows follow the active status filter, and
 * `countRevision` advances whenever a patch may move an Offer between status
 * counts, so the route revalidates the authoritative counts.
 */
export function applySubmittedOfferListPatch<
  T extends { offer_id: string; status: string },
  Snapshot extends ListResponse<T> & { countRevision: number },
>(current: Snapshot, patch: RealtimeProjectionPatch, statusFilter: string): Snapshot {
  const statusMayHaveChanged = patch.changes.some((change) => {
    if (change.entity !== "marketplace.offer") return false;
    if (change.op !== "upsert") return true;
    const known = current.items.find((item) => item.offer_id === change.id);
    return !known || known.status !== (change.value as T).status;
  });
  return {
    ...current,
    ...applyMarketplaceListPatch(current, patch, {
      entity: "marketplace.offer",
      idField: "offer_id",
      matches: statusFilter === "all" ? undefined : (item) => item.status === statusFilter,
    }),
    countRevision: current.countRevision + (statusMayHaveChanged ? 1 : 0),
  };
}
