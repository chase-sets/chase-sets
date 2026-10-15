import type {
  InventoryHoldSourceRef,
  InventoryRestockDecisionOutcome,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { assert } from "../../../support/runtime-support/common";

export type InventoryRestockDecisionRow = Readonly<{
  decision_id: string;
  version: number;
  account_id: string;
  order_id: string;
  item_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  product_summary: string | null;
  quantity: number;
  source: "order-cancelled-after-dispatch" | "shipment-returned";
  source_ref: InventoryHoldSourceRef;
  shipment_id: string | null;
  return_reason: string | null;
  status: "pending" | "recorded";
  outcome: InventoryRestockDecisionOutcome | null;
  damage_note: string | null;
  pending_at: string;
  decided_at: string | null;
  updated_at: string;
}>;

export type InventoryFulfillmentShipmentSourceRow = Readonly<{
  shipment_id: string;
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
}>;

export async function listPendingRestockDecisions(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
) {
  const requestedLimit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  assert(Number.isSafeInteger(requestedLimit) && requestedLimit > 0, "Restock page limit is invalid.");
  assert(Number.isSafeInteger(offset) && offset >= 0, "Restock page offset is invalid.");
  const limit = Math.min(requestedLimit, 250);
  const result = await db.query<InventoryRestockDecisionRow & Readonly<{ total_count: number }>>(
    `WITH paged AS (
       SELECT *, COUNT(*) OVER()::integer AS total_count
       FROM inventory_restock_decisions
       WHERE account_id = $1
         AND status = 'pending'
       ORDER BY pending_at DESC, decision_id ASC
       LIMIT $2
       OFFSET $3
     )
     SELECT
       paged.total_count,
       paged.decision_id,
       paged.last_stream_version AS version,
       paged.account_id,
       paged.order_id,
       paged.item_id,
       catalog.title AS item_title,
       catalog.subtitle AS item_subtitle,
       NULL::text AS product_summary,
       paged.quantity,
       paged.source,
       paged.source_ref,
       paged.shipment_id,
       paged.return_reason,
       paged.status,
       paged.outcome,
       paged.damage_note,
       paged.pending_at,
       paged.decided_at,
       paged.updated_at
     FROM paged
     LEFT JOIN inventory_items AS item
       ON item.item_id = paged.item_id
     LEFT JOIN inventory_catalog_items AS catalog
       ON catalog.catalog_item_id = item.catalog_catalog_item_id
     ORDER BY paged.pending_at DESC, paged.decision_id ASC`,
    [params.accountId, limit, offset],
  );

  const total = result.rows.length
    ? Number(result.rows[0].total_count)
    : Number(
        (
          await db.query<{ total: string }>(
            "SELECT COUNT(*)::text AS total FROM inventory_restock_decisions WHERE account_id = $1 AND status = 'pending'",
            [params.accountId],
          )
        ).rows[0]?.total ?? 0,
      );
  return {
    items: result.rows.map(({ total_count: _totalCount, ...row }) => ({ ...row, version: Number(row.version) })),
    total,
  };
}

export async function getRestockDecision(db: PgQueryable, decisionId: string, accountId: string) {
  const result = await db.query<InventoryRestockDecisionRow>(
    `SELECT
       decision.decision_id,
       decision.last_stream_version AS version,
       decision.account_id,
       decision.order_id,
       decision.item_id,
       catalog.title AS item_title,
       catalog.subtitle AS item_subtitle,
       NULL::text AS product_summary,
       decision.quantity,
       decision.source,
       decision.source_ref,
       decision.shipment_id,
       decision.return_reason,
       decision.status,
       decision.outcome,
       decision.damage_note,
       decision.pending_at,
       decision.decided_at,
       decision.updated_at
     FROM inventory_restock_decisions AS decision
     LEFT JOIN inventory_items AS item
       ON item.item_id = decision.item_id
     LEFT JOIN inventory_catalog_items AS catalog
       ON catalog.catalog_item_id = item.catalog_catalog_item_id
     WHERE decision.decision_id = $1
       AND decision.account_id = $2`,
    [decisionId, accountId],
  );

  return result.rows[0] ? { ...result.rows[0], version: Number(result.rows[0].version) } : null;
}

export async function getFulfillmentShipmentSource(db: PgQueryable, shipmentId: string) {
  const result = await db.query<InventoryFulfillmentShipmentSourceRow>(
    `SELECT shipment_id, order_id, buyer_account_id, seller_account_id
     FROM inventory_fulfillment_shipment_sources
     WHERE shipment_id = $1`,
    [shipmentId],
  );

  return result.rows[0] ?? null;
}
