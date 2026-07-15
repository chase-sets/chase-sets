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
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildFulfillmentCommandCenter, type FulfillmentCommandCenterShipmentInput } from "./command-center";

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

export function createShipByAttentionSourceFromReadModel(db: PgQueryable): SellerAttentionSource {
  return {
    id: "fulfillment-ship-by",
    load: async (context) => {
      const result = await db.query<FulfillmentCommandCenterShipmentInput>(
        `SELECT
           page.shipment_id,
           page.order_id,
           page.display_reference,
           page.status,
           page.label_status,
           page.tracking_identifier,
           page.carrier_name,
           buyer.display_name AS buyer_display_name,
           page.current_exception_type,
           page.current_exception_notes,
           COALESCE(line_stats.line_count, 0)::integer AS line_count,
           COALESCE(line_stats.total_quantity, 0)::integer AS total_quantity,
           page.created_at,
           page.updated_at
         FROM fulfillment_shipment_pages AS page
         LEFT JOIN fulfillment_account_pages AS buyer
           ON buyer.account_id = page.buyer_account_id
         LEFT JOIN (
           SELECT shipment_id, COUNT(*) AS line_count, COALESCE(SUM(quantity), 0) AS total_quantity
           FROM fulfillment_shipment_line_pages
           GROUP BY shipment_id
         ) AS line_stats
           ON line_stats.shipment_id = page.shipment_id
         WHERE page.seller_account_id = $1
           AND page.status IN ('awaiting-package', 'packing', 'awaiting-label', 'label-attached', 'exception')
         ORDER BY page.created_at ASC, page.shipment_id ASC`,
        [context.accountId],
      );

      return buildFulfillmentCommandCenter(result.rows).queue.map((item) => item.attention);
    },
  };
}
