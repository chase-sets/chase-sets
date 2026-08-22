import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

/**
 * Index backing the Inventory-owned reverse Hold lookup (#7222 option B).
 *
 * The lookup answers "which Hold streams carry this Order id in their source
 * reference?" from Inventory's own `event_store_events`, covering the two
 * source-bearing events an Order Hold can be born from: a direct
 * `inventory.hold.placed` with purpose `order`, and an
 * `inventory.hold.converted` that promotes a checkout Hold to purpose
 * `order`. The UNLOGGED `inventory_reservation_pages` projection is never
 * the authority for that question.
 */
export const INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME = "event_store_events_inventory_hold_source_order_idx";

/**
 * Leading `tenant_id` plus the `sourceRef.orderId` expression, then
 * `global_position` and `stream_id` so the "first matching global position,
 * then stream id" ordering is served from the index. Partial to the two
 * source-bearing Hold event types.
 */
export const INVENTORY_HOLD_SOURCE_ORDER_INDEX_STATEMENT = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INVENTORY_HOLD_SOURCE_ORDER_INDEX_NAME}
  ON event_store_events (tenant_id, ((payload -> 'sourceRef' ->> 'orderId')), global_position, stream_id)
  WHERE event_type IN ('inventory.hold.placed', 'inventory.hold.converted');`;

/**
 * A newly identified Inventory-owned migration. It is deliberately *not* an
 * amendment of the already-recorded shared
 * `20260628_event_store_events_concurrent_indexes` migration: that ledger row
 * exists on every deployed database, so appending a statement to it would
 * never run. `CREATE INDEX CONCURRENTLY` is safe here because bounded-context
 * migrations execute statement-by-statement on a raw client outside any
 * transaction, and `IF NOT EXISTS` makes a second boot a no-op even before the
 * ledger row is written.
 */
export const inventoryHoldSourceIndexSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260822_inventory_hold_source_order_index",
    description: "Create the concurrent partial Inventory Hold sourceRef/order lookup index.",
    statements: [INVENTORY_HOLD_SOURCE_ORDER_INDEX_STATEMENT],
  },
];
