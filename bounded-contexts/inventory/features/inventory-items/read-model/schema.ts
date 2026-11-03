import type { BcSchemaMigration, BcSchemaMigrationClient } from "@chase-sets/bounded-context-module";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";

export const inventoryItemSchemaSql = `
CREATE TABLE IF NOT EXISTS inventory_items (
  item_id text PRIMARY KEY,
  account_id text NOT NULL,
  catalog_catalog_item_id text NOT NULL,
  product_id text NOT NULL,
  selected_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  graded_card jsonb NULL,
  storage_location_id text NOT NULL REFERENCES inventory_storage_locations(storage_location_id),
  total_quantity integer NOT NULL CHECK (total_quantity >= 0),
  last_stream_version bigint NOT NULL DEFAULT 0 CHECK (last_stream_version >= 0),
  acquisition_cost_amount numeric(12,2) NULL,
  acquisition_cost_currency_code text NULL CONSTRAINT inventory_items_acquisition_cost_currency_check CHECK (
    acquisition_cost_currency_code IS NULL OR
    (acquisition_cost_amount IS NOT NULL AND acquisition_cost_currency_code ~ '^[A-Z]{3}$')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL;

CREATE INDEX IF NOT EXISTS inventory_items_account_idx
  ON inventory_items (account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS inventory_items_storage_location_idx
  ON inventory_items (storage_location_id);

CREATE INDEX IF NOT EXISTS inventory_items_catalog_version_idx
  ON inventory_items (product_id);

CREATE TABLE IF NOT EXISTS inventory_item_ledger (
  ledger_entry_id text PRIMARY KEY,
  item_id text NOT NULL,
  account_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL,
  quantity_delta integer NULL,
  hold_quantity integer NULL,
  purpose text NULL,
  reason text NOT NULL,
  reason_code text NULL,
  note text NULL,
  sale_price_amount numeric(12,2) NULL,
  channel text NULL,
  source_ref jsonb NULL,
  actor text NOT NULL,
  event_type text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version >= 1),
  recorded_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_item_adjustment_idempotency (
  idempotency_key text PRIMARY KEY,
  account_id text NOT NULL,
  item_id text NOT NULL,
  command_fingerprint text NOT NULL,
  claim_generation text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  result_item_id text NULL,
  result_version bigint NULL CHECK (result_version IS NULL OR result_version >= 0),
  result_collision jsonb NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS inventory_item_adjustment_idempotency_item_idx
  ON inventory_item_adjustment_idempotency (account_id, item_id, created_at DESC);
`;

export const inventoryItemSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260707_inventory_item_ledger_indexes",
    description: "Build stock-ledger read indexes outside boot-time schema SQL.",
    statements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_item_occurred_idx
  ON inventory_item_ledger (item_id, occurred_at DESC, ledger_entry_id DESC)`,
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS inventory_item_ledger_account_item_idx
  ON inventory_item_ledger (account_id, item_id, occurred_at DESC)`,
    ],
  },
  {
    migrationId: "20260819_inventory_item_ledger_adjustment_reason",
    description: "Add the typed adjustment reason and optional operator note to the stock ledger.",
    statements: [
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS reason_code text`,
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS note text`,
    ],
  },
  {
    migrationId: "20260825_inventory_offline_sale",
    description: "Persist offline-sale ledger detail and collision-aware idempotency results.",
    statements: [
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS sale_price_amount numeric(12,2)`,
      `ALTER TABLE inventory_item_ledger
  ADD COLUMN IF NOT EXISTS channel text`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  ADD COLUMN IF NOT EXISTS result_collision jsonb`,
    ],
  },
  {
    migrationId: "20260906_inventory_adjustment_claim_generation",
    description: "Fence adjustment journal completion and release to the exact claim generation.",
    statements: [
      `ALTER TABLE inventory_item_adjustment_idempotency
  ADD COLUMN IF NOT EXISTS claim_generation text`,
      `UPDATE inventory_item_adjustment_idempotency
  SET claim_generation = 'legacy:' || idempotency_key || ':' || created_at::text
  WHERE claim_generation IS NULL`,
      `DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_item_adjustment_idempotency_claim_generation_not_null'
      AND conrelid = 'inventory_item_adjustment_idempotency'::regclass
  ) THEN
    ALTER TABLE inventory_item_adjustment_idempotency
      ADD CONSTRAINT inventory_item_adjustment_idempotency_claim_generation_not_null
      CHECK (claim_generation IS NOT NULL) NOT VALID;
  END IF;
END
$migration$`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  VALIDATE CONSTRAINT inventory_item_adjustment_idempotency_claim_generation_not_null`,
      `SET LOCAL lock_timeout = '5s'`,
      `ALTER TABLE inventory_item_adjustment_idempotency
  ALTER COLUMN claim_generation SET NOT NULL`,
    ],
  },
  {
    migrationId: "20260909_inventory_acquisition_cost_currency",
    description: "Preserve Inventory-authored acquisition cost denomination; retained amount-only rows stay null.",
    statements: [
      `ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS acquisition_cost_currency_code text NULL`,
      `DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inventory_items_acquisition_cost_currency_check'
      AND conrelid = 'inventory_items'::regclass
  ) THEN
    ALTER TABLE inventory_items
      ADD CONSTRAINT inventory_items_acquisition_cost_currency_check
      CHECK (
        acquisition_cost_currency_code IS NULL OR
        (acquisition_cost_amount IS NOT NULL AND acquisition_cost_currency_code ~ '^[A-Z]{3}$')
      ) NOT VALID;
  END IF;
END
$migration$`,
      `ALTER TABLE inventory_items
  VALIDATE CONSTRAINT inventory_items_acquisition_cost_currency_check`,
    ],
  },
  {
    migrationId: "20261028_inventory_offline_sale_ledger_handoff",
    description: "Retire quantity-bearing offline-sale audit writes and reconcile retained ledger detail atomically.",
    statements: [],
    dataStep: async (db: BcSchemaMigrationClient) => {
      const deadline = Date.now() + 60_000;
      async function query<Row = Record<string, unknown>>(sql: string) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error("60-second deadline exceeded");
        }
        await db.query("SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`]);
        const result = await db.query<Row>(sql);
        if (Date.now() >= deadline) {
          throw new Error("60-second deadline exceeded");
        }
        return result;
      }

      try {
        await query("SET LOCAL lock_timeout = '5s'");
        await query("LOCK TABLE inventory_item_ledger IN ACCESS EXCLUSIVE MODE");
        const retained = await query("SELECT ledger_entry_id FROM inventory_item_ledger LIMIT 100001");
        if (retained.rows.length > 100_000) {
          throw new Error("ledger exceeds the 100000-row handoff bound");
        }
        await query(`ALTER TABLE inventory_item_ledger
          ADD CONSTRAINT inventory_item_ledger_offline_sale_null_delta
          CHECK (NOT (kind = 'offline-sale'
            AND event_type = 'inventory.item.offline-sale-recorded'
            AND quantity_delta IS NOT NULL)) NOT VALID`);
        await query(`UPDATE inventory_item_ledger SET quantity_delta = NULL
          WHERE kind = 'offline-sale'
            AND event_type = 'inventory.item.offline-sale-recorded'
            AND quantity_delta IS NOT NULL`);
        await query(`ALTER TABLE inventory_item_ledger
          VALIDATE CONSTRAINT inventory_item_ledger_offline_sale_null_delta`);
        const remaining = await query(`SELECT ledger_entry_id FROM inventory_item_ledger
          WHERE kind = 'offline-sale'
            AND event_type = 'inventory.item.offline-sale-recorded'
            AND quantity_delta IS NOT NULL LIMIT 1`);
        if (remaining.rows.length !== 0) {
          throw new Error("quantity-bearing offline-sale audit rows remain");
        }
      } catch (cause) {
        throw new Error("Inventory offline-sale ledger handoff incomplete", { cause });
      }
    },
  },
  {
    migrationId: "20261102_inventory_hold_consumption_handoff",
    description: "Reconcile retained consumed-hold audit rows so stock movement is represented exactly once.",
    statements: [],
    dataStep: async (db: BcSchemaMigrationClient) => {
      const deadline = Date.now() + 60_000;
      async function query<Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("60-second deadline exceeded");
        await db.query("SELECT set_config('statement_timeout', $1, true)", [`${remaining}ms`]);
        const result = await db.query<Row>(sql, values);
        if (Date.now() >= deadline) throw new Error("60-second deadline exceeded");
        return result;
      }

      try {
        await query("SET LOCAL lock_timeout = '5s'");
        await query("LOCK TABLE event_store_streams IN EXCLUSIVE MODE");
        await query("SELECT pg_advisory_xact_lock(-8041932795057830931::bigint)");
        const horizon = await query<{ head: string }>(
          `SELECT COALESCE(
             pg_sequence_last_value(pg_get_serial_sequence('event_store_events', 'global_position')::regclass),
             0
           )::bigint::text AS head`,
        );
        const capturedHorizon = BigInt(horizon.rows[0]?.head ?? "0");
        await query("LOCK TABLE inventory_item_ledger IN ACCESS EXCLUSIVE MODE");
        type RetainedConsumption = {
          hold_stream_id: string;
          hold_stream_version: number;
          tenant_id: string;
          performed_by_user_id: string;
          for_account_id: string;
          occurred_at: string;
          payload: unknown;
          placement_count: number;
          placements: unknown[] | null;
        };
        const retained = await query<RetainedConsumption>(
          `SELECT consumed.stream_id AS hold_stream_id,
                  consumed.stream_version AS hold_stream_version,
                  consumed.tenant_id,
                  consumed.performed_by_user_id,
                  consumed.for_account_id,
                  consumed.occurred_at,
                  consumed.payload,
                  placement.placement_count,
                  placement.placements
           FROM event_store_events AS consumed
           JOIN LATERAL (
             SELECT count(*)::int AS placement_count,
                    jsonb_agg(payload ORDER BY stream_version) AS placements
             FROM event_store_events
             WHERE stream_id = consumed.stream_id AND event_type = 'inventory.hold.placed'
           ) AS placement ON true
           WHERE consumed.event_type = 'inventory.hold.consumed'
             AND consumed.global_position <= $1::bigint
             AND NOT EXISTS (
               SELECT 1 FROM event_store_events AS companion
               WHERE companion.event_type = 'inventory.item.adjusted'
                 AND companion.metadata -> 'inventoryConsumptionPair' ->> 'pairedStreamId' = consumed.stream_id
                 AND (companion.metadata -> 'inventoryConsumptionPair' ->> 'pairedStreamVersion')::bigint = consumed.stream_version
             )
           ORDER BY consumed.global_position
           LIMIT 100001`,
          [capturedHorizon.toString()],
        );
        const ledger = await query<{
          ledger_entry_id: string;
          stream_id: string;
          stream_version: number;
          item_id: string;
          account_id: string;
          hold_quantity: number | null;
          quantity_delta: number | null;
        }>(
          "SELECT ledger_entry_id, stream_id, stream_version, item_id, account_id, hold_quantity, quantity_delta FROM inventory_item_ledger WHERE kind = 'hold-consumed' LIMIT 100001",
        );
        if (retained.rows.length > 100_000 || ledger.rows.length > 100_000) {
          throw new Error("consumed-hold handoff exceeds the 100000-row bound");
        }
        if (retained.rows.length > 0 && !db.appendToStreamsInTransaction) {
          throw new Error("transaction-bound event-store append is unavailable");
        }
        const ledgerByEvent = new Map(
          ledger.rows.map((entry) => [`${entry.stream_id}:${entry.stream_version}`, entry]),
        );
        const groups = new Map<
          string,
          { itemId: string; accountId: string; tenantId: string; actor: string; rows: readonly RetainedConsumption[] }
        >();
        for (const row of retained.rows) {
          if (row.placement_count !== 1 || !row.placements?.[0] || typeof row.placements[0] !== "object") {
            throw new Error("consumed-hold handoff found ambiguous or missing hold placement identity");
          }
          const placement = row.placements[0] as Record<string, unknown>;
          const itemId = typeof placement.itemId === "string" ? placement.itemId : "";
          const quantity = placement.quantity;
          const accountId = typeof placement.accountId === "string" ? placement.accountId : row.for_account_id;
          if (!itemId || !Number.isSafeInteger(quantity) || Number(quantity) <= 0 || placement.purpose !== "order") {
            throw new Error("consumed-hold handoff failed identity, quantity, or hold-purpose preflight");
          }
          if (accountId !== row.for_account_id || !row.tenant_id || !row.performed_by_user_id) {
            throw new Error("consumed-hold handoff failed tenant/account/actor preflight");
          }
          const ledgerRow = ledgerByEvent.get(`${row.hold_stream_id}:${row.hold_stream_version}`);
          if (
            ledgerRow &&
            (ledgerRow.account_id !== accountId ||
              ledgerRow.item_id !== itemId ||
              ledgerRow.hold_quantity !== Number(quantity) ||
              ledgerRow.quantity_delta !== null)
          ) {
            throw new Error("consumed-hold handoff failed retained compensation preflight");
          }
          const existing = groups.get(itemId);
          groups.set(itemId, {
            itemId,
            accountId,
            tenantId: row.tenant_id,
            actor: row.performed_by_user_id,
            rows: existing ? [...existing.rows, row] : [row],
          });
        }
        const itemIds = [...groups.keys()].map((itemId) => `inventory.item-${itemId}`);
        const itemRows = itemIds.length
          ? await query<{ stream_id: string; current_version: number; total_quantity: number }>(
              `SELECT streams.stream_id,
                      streams.current_version,
                      COALESCE(created.total_quantity, 0) + COALESCE(adjustments.quantity_delta, 0) AS total_quantity
               FROM event_store_streams AS streams
               LEFT JOIN LATERAL (
                 SELECT (payload ->> 'totalQuantity')::int AS total_quantity
                 FROM event_store_events
                 WHERE stream_id = streams.stream_id AND event_type = 'inventory.item.created'
                 ORDER BY stream_version LIMIT 1
               ) AS created ON true
               LEFT JOIN LATERAL (
                 SELECT COALESCE(sum((payload ->> 'quantityDelta')::int), 0)::int AS quantity_delta
                 FROM event_store_events
                 WHERE stream_id = streams.stream_id AND event_type = 'inventory.item.adjusted'
               ) AS adjustments ON true
               WHERE streams.stream_id = ANY($1::text[])
               FOR UPDATE OF streams`,
              [itemIds],
            )
          : { rows: [] };
        const versions = new Map(itemRows.rows.map((entry) => [entry.stream_id, Number(entry.current_version)]));
        const appends: AppendToStreamInput[] = [];
        for (const group of groups.values()) {
          const itemStreamId = `inventory.item-${group.itemId}`;
          const currentVersion = versions.get(itemStreamId);
          if (currentVersion === undefined) throw new Error("consumed-hold handoff failed item stream preflight");
          const item = itemRows.rows.find((entry) => entry.stream_id === itemStreamId);
          const requiredQuantity = group.rows.reduce(
            (sum, row) => sum + Number((row.placements![0] as Record<string, unknown>).quantity),
            0,
          );
          if (!item || !Number.isSafeInteger(item.total_quantity) || item.total_quantity < requiredQuantity) {
            throw new Error("consumed-hold handoff failed stock floor preflight");
          }
          const ambiguous = await query<{ count: number }>(
            `SELECT count(*)::int AS count
             FROM event_store_events
             WHERE stream_id = $1
               AND event_type = 'inventory.item.adjusted'
               AND global_position <= $2::bigint
               AND payload ->> 'reasonCode' = 'sale-consumed'
               AND NOT (metadata ? 'inventoryConsumptionPair')`,
            [itemStreamId, capturedHorizon.toString()],
          );
          if ((ambiguous.rows[0]?.count ?? 0) > 0) {
            throw new Error("consumed-hold handoff found an ambiguous unbound stock adjustment");
          }
          const events = group.rows.map((row) => {
            const placement = row.placements![0] as Record<string, unknown>;
            const quantity = Number(placement.quantity);
            const pairId = `inventory-consumption:${row.hold_stream_id}:${row.hold_stream_version}:handoff`;
            return {
              eventType: "inventory.item.adjusted",
              payload: {
                itemId: group.itemId,
                quantityDelta: -quantity,
                reason: "Stock consumed",
                reasonCode: "sale-consumed",
                sourceRef: (placement.sourceRef as JsonObject | null | undefined) ?? null,
              },
              metadata: {
                inventoryConsumptionPair: {
                  pairId,
                  pairedStreamId: row.hold_stream_id,
                  pairedStreamVersion: Number(row.hold_stream_version),
                },
              },
              occurredAt: row.occurred_at as never,
            };
          });
          appends.push({
            streamId: itemStreamId,
            expectedVersion: currentVersion,
            context: {
              tenantId: group.tenantId as never,
              audit: { performedByUserId: group.actor as never, forAccountId: group.accountId as never },
            },
            events,
          });
        }
        if (appends.length > 0) {
          await db.appendToStreamsInTransaction!(appends);
        }
        await query(
          "UPDATE inventory_item_ledger SET quantity_delta = NULL WHERE kind = 'hold-consumed' AND event_type = 'inventory.hold.consumed' AND quantity_delta IS NOT NULL",
        );
        await query(
          "ALTER TABLE inventory_item_ledger ADD CONSTRAINT inventory_item_ledger_consumed_null_delta CHECK (NOT (kind = 'hold-consumed' AND event_type = 'inventory.hold.consumed' AND quantity_delta IS NOT NULL)) NOT VALID",
        );
        await query("ALTER TABLE inventory_item_ledger VALIDATE CONSTRAINT inventory_item_ledger_consumed_null_delta");
        const lateConsumed = await query<{ count: number }>(
          "SELECT count(*)::int AS count FROM event_store_events WHERE event_type = 'inventory.hold.consumed' AND global_position > $1::bigint",
          [capturedHorizon.toString()],
        );
        if ((lateConsumed.rows[0]?.count ?? 0) !== 0) {
          throw new Error("consumed-hold handoff found a consumed event beyond the captured horizon");
        }
        const horizonCheck = await query<{ missing: number }>(
          `SELECT count(*)::int AS missing
           FROM event_store_events AS consumed
           WHERE consumed.event_type = 'inventory.hold.consumed'
             AND consumed.global_position <= $1::bigint
             AND NOT EXISTS (
               SELECT 1 FROM event_store_events AS companion
               WHERE companion.event_type = 'inventory.item.adjusted'
                 AND companion.global_position > $1::bigint
                 AND companion.metadata -> 'inventoryConsumptionPair' ->> 'pairedStreamId' = consumed.stream_id
                 AND (companion.metadata -> 'inventoryConsumptionPair' ->> 'pairedStreamVersion')::bigint = consumed.stream_version
                 AND companion.metadata -> 'inventoryConsumptionPair' ->> 'pairId' IS NOT NULL
             )`,
          [capturedHorizon.toString()],
        );
        if ((horizonCheck.rows[0]?.missing ?? 0) !== 0) {
          throw new Error("consumed-hold handoff event horizon check failed");
        }
      } catch (cause) {
        throw new Error("Inventory consumed-hold handoff incomplete", { cause });
      }
    },
  },
];
