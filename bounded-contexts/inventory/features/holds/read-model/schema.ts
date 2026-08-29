import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const inventoryHoldSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_holds (
  hold_id text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL REFERENCES inventory_items(item_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  notes text NULL,
  purpose text NOT NULL DEFAULT 'manual',
  source_ref jsonb NULL,
  expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  release_reason text NULL,
  consumed_at timestamptz NULL,
  expired_at timestamptz NULL,
  extension_count integer NOT NULL DEFAULT 0,
  last_stream_version bigint NOT NULL DEFAULT 0
);

ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS source_ref jsonb NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS release_reason text NULL,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS inventory_holds_account_idx
  ON inventory_holds (account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_holds_item_idx
  ON inventory_holds (item_id, status);
`;

export const inventoryHoldSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_inventory_hold_checkout_lifecycle",
    description: "Add checkout hold expiry and extension read-model columns.",
    // Metadata-only ADD COLUMN changes (PostgreSQL 11+) that hold ACCESS EXCLUSIVE only for
    // an instant. The earlier ADD (nullable) -> UPDATE -> SET DEFAULT -> SET NOT NULL sequence
    // held ACCESS EXCLUSIVE across a full-table validation scan and hung the bootstrap under
    // live read traffic. See #4638.
    statements: [
      `ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL;`,
      `ALTER TABLE inventory_holds
  ADD COLUMN IF NOT EXISTS extension_count integer NOT NULL DEFAULT 0;`,
    ],
  },
];

/**
 * Index backing the Inventory-owned reverse Hold lookup.
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
