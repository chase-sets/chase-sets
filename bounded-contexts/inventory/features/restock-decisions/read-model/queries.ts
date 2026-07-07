import type {
  InventoryHoldSourceRef,
  InventoryRestockDecisionOutcome,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryRestockDecisionRow = Readonly<{
  decision_id: string;
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
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
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

  return {
    items: result.rows.map(({ total_count: _totalCount, ...row }) => row),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export async function getRestockDecision(db: PgQueryable, decisionId: string, accountId: string) {
  const result = await db.query<InventoryRestockDecisionRow>(
    `SELECT
       decision.decision_id,
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

  return result.rows[0] ?? null;
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
