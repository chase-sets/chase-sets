// Fulfillment's contribution to the Seller Desk attention queue — the ship-by
// source. A plain query module (no HTTP, no UI) that maps shipments still owed a
// dispatch into the shared attention item shape, ordered by their ship-by
// deadline. The aggregation at the seller edge composes this with the other
// contexts' sources; this module owns only fulfillment's mapping.

import {
  buildSellerAttentionItem,
  type SellerAttentionContext,
  type SellerAttentionItem,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

// The projected fields the ship-by source reads from the shipment read model.
// Only shipments awaiting the seller's dispatch with a ship-by deadline appear.
export type ShipByAttentionRow = Readonly<{
  shipmentId: string;
  // Human display reference for the shipment (the seller-facing identifier).
  reference: string;
  // ISO-8601 UTC ship-by deadline the seller committed to.
  shipByAt: string;
  // ISO-8601 UTC time the shipment became the seller's to dispatch.
  observedAt: string;
}>;

// One day of runway before a ship-by deadline escalates from upcoming to soon.
const SHIP_BY_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

function shipBySeverity(shipByAt: string, now: string): "critical" | "warning" | "info" {
  const due = Date.parse(shipByAt);
  const evaluatedAt = Date.parse(now);
  if (Number.isNaN(due) || Number.isNaN(evaluatedAt)) {
    return "warning";
  }
  if (due <= evaluatedAt) {
    return "critical";
  }
  if (due - evaluatedAt <= SHIP_BY_SOON_WINDOW_MS) {
    return "warning";
  }
  return "info";
}

function summaryCode(severity: "critical" | "warning" | "info"): string {
  if (severity === "critical") {
    return "ship-by-overdue";
  }
  if (severity === "warning") {
    return "ship-by-soon";
  }
  return "ship-by-upcoming";
}

// Pure mapping: shipment rows → attention items. Deterministic given `now`.
export function toShipByAttentionItems(
  rows: readonly ShipByAttentionRow[],
  context: SellerAttentionContext,
): readonly SellerAttentionItem[] {
  return rows.map((row) => {
    const severity = shipBySeverity(row.shipByAt, context.now);
    return buildSellerAttentionItem({
      source: "fulfillment-ship-by",
      entityId: row.shipmentId,
      severity,
      summary: { code: summaryCode(severity), params: { reference: row.reference, dueAt: row.shipByAt } },
      dueAt: row.shipByAt,
      observedAt: row.observedAt,
    });
  });
}

export type ShipByAttentionSourceDependencies = Readonly<{
  loadShipByRows: (context: SellerAttentionContext) => Promise<readonly ShipByAttentionRow[]>;
}>;

// Wire the ship-by source with an injected read query, keeping the mapping pure
// and the query the owning context's responsibility.
export function createShipByAttentionSource(dependencies: ShipByAttentionSourceDependencies): SellerAttentionSource {
  return {
    id: "fulfillment-ship-by",
    load: async (context) => toShipByAttentionItems(await dependencies.loadShipByRows(context), context),
  };
}
