import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import {
  createTransientProjectionError,
  defineProjectorHandlers,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export async function resetInventoryRestockDecisionProjection(db: PgQueryable): Promise<void> {
  const missing = await db.query<{ parent_id: string }>(
    `SELECT event.payload->>'itemId' AS parent_id FROM event_store_events event
     WHERE event.event_type = 'inventory.restock-decision.pending'
       AND NOT EXISTS (SELECT 1 FROM inventory_items item WHERE item.item_id = event.payload->>'itemId')
     ORDER BY event.global_position LIMIT 1`,
  );
  if (missing.rows[0]) {
    throw new Error(
      `Cannot reset Inventory restock decisions: missing item '${missing.rows[0].parent_id}'; rebuild inventory-item-projection first.`,
    );
  }
  await db.query("DELETE FROM inventory_restock_decisions");
}

export function buildInventoryRestockDecisionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.restock-decision.pending": async (event) => {
      const data = event.data as {
        decisionId: string;
        accountId: string;
        orderId: string;
        itemId: string;
        quantity: number;
        source: string;
        sourceRef: unknown;
        shipmentId: string | null;
        returnReason: string | null;
        pendingAt: string;
      };

      await db
        .query(
          `INSERT INTO inventory_restock_decisions (
           decision_id,
           account_id,
           order_id,
           item_id,
           quantity,
           source,
           source_ref,
           shipment_id,
           return_reason,
           status,
           outcome,
           damage_note,
           pending_at,
           decided_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'pending', NULL, NULL, $10, NULL, $11, $12)
         ON CONFLICT (decision_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             order_id = EXCLUDED.order_id,
             item_id = EXCLUDED.item_id,
             quantity = EXCLUDED.quantity,
             source = EXCLUDED.source,
             source_ref = EXCLUDED.source_ref,
             shipment_id = EXCLUDED.shipment_id,
             return_reason = EXCLUDED.return_reason,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE inventory_restock_decisions.last_stream_version < EXCLUDED.last_stream_version
           AND inventory_restock_decisions.status = 'pending'`,
          [
            data.decisionId,
            data.accountId,
            data.orderId,
            data.itemId,
            data.quantity,
            data.source,
            JSON.stringify(data.sourceRef),
            data.shipmentId,
            data.returnReason,
            data.pendingAt,
            event.timing.recordedAt,
            event.streamVersion,
          ],
        )
        .catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23503" &&
            "constraint" in error &&
            error.constraint === "inventory_restock_decisions_item_id_fkey"
          ) {
            throw createTransientProjectionError(
              `Inventory restock decision '${data.decisionId}' is missing item '${data.itemId}'; rebuild inventory-item-projection first.`,
              { cause: error },
            );
          }
          throw error;
        });
    },
    "inventory.restock-decision.recorded": async (event) => {
      const data = event.data as {
        decisionId: string;
        outcome: string;
        damageNote: string | null;
        decidedAt: string;
      };

      await db.query(
        `UPDATE inventory_restock_decisions
         SET status = 'recorded',
             outcome = $2,
             damage_note = $3,
             decided_at = $4,
             updated_at = $5,
             last_stream_version = $6
         WHERE decision_id = $1
           AND last_stream_version < $6`,
        [data.decisionId, data.outcome, data.damageNote, data.decidedAt, event.timing.recordedAt, event.streamVersion],
      );
    },
  };
}

export function buildInventoryFulfillmentSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<ChaseSetsEventPayloads, "fulfillment.shipment.created">>({
    "fulfillment.shipment.created": async (event) => {
      const { data } = event;

      await db.query(
        `INSERT INTO inventory_fulfillment_shipment_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             updated_at = EXCLUDED.updated_at`,
        [data.shipmentId, data.orderId, data.buyerAccountId, data.sellerAccountId, data.createdAt],
      );
    },
  });
}
