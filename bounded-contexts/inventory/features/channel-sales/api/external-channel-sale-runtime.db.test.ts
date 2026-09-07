import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { decideInventoryItem, initialInventoryItemState } from "../../inventory-items/domain/domain";
import { createInventoryHoldCollisionRuntime } from "../../hold-collisions/api/runtime";
import { module as inventoryModule } from "../../..";
import {
  claimInventoryAdjustmentIdempotency,
  completeInventoryAdjustmentIdempotency,
  releaseInventoryAdjustmentIdempotency,
} from "../../../support/runtime-support/inventory-adjustment-idempotency";
import { externalChannelSaleStreamId } from "../domain/validation";
import type { RecordExternalChannelSaleCommand } from "./contracts";
import { createInventoryExternalChannelSaleRuntime, externalChannelSaleCommandFingerprint } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;

const context: EventStoreContext = {
  tenantId: "tnt_external_sales" as never,
  audit: { performedByUserId: "usr_inventory_system" as never, forAccountId: "acc_seller" as never },
};

function command(
  line: string,
  overrides: Partial<RecordExternalChannelSaleCommand> = {},
): RecordExternalChannelSaleCommand {
  return {
    accountId: "acc_seller",
    inventoryItemId: "inv_external",
    storageLocationId: "loc_external",
    saleKey: {
      version: "v1",
      providerKey: "synthetic-provider",
      sellerEnvironmentLineage: "seller-production",
      orderLineIdentity: line,
    },
    requestedQuantity: 1,
    unitPriceAmount: "25.00",
    currencyCode: "USD",
    soldAt: "2026-09-06T12:00:00-05:00",
    ...overrides,
  };
}

describeDb("external-channel-sale real event-store authority", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let services: ReturnType<typeof inventoryModule.createServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "external_channel_sales");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    eventStore = createPostgresEventStore({ pool });
    services = inventoryModule.createServices(pool, {});
    await seedItem("inv_external", 100);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function seedItem(itemId: string, totalQuantity: number, storageLocationId = "loc_external") {
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: itemId as never,
      accountId: "acc_seller" as never,
      catalogItemId: "cat_external" as never,
      productId: "cat_external::raw" as never,
      selectedOptions: [],
      storageLocationId,
      totalQuantity,
      acquisitionCostAmount: "10.00",
    });
    await eventStore.appendToStream({
      streamId: `inventory.item-${itemId}`,
      expectedVersion: "no_stream",
      events: [{ eventType: created!.type, payload: created!.data }],
      context,
    });
  }

  async function countEvents(eventType: string, streamId?: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_store_events WHERE event_type = $1${streamId ? " AND stream_id = $2" : ""}`,
      streamId ? [eventType, streamId] : [eventType],
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async function appendPoison(line: string, eventType: string, payload: Record<string, unknown>) {
    const saleStreamId = externalChannelSaleStreamId(command(line).saleKey);
    await eventStore.appendToStream({
      streamId: saleStreamId,
      expectedVersion: "no_stream",
      events: [{ eventType, payload: payload as never }],
      context,
    });
    return saleStreamId;
  }

  it("external-channel-sale-idempotency preserves one terminal fact and typed conflicts", async () => {
    const first = await services.channelSales.record(command("idempotency"), context);
    const replay = await services.channelSales.record(
      command("idempotency", { connectionAuditReference: "another-connection" }),
      context,
    );
    const conflict = await services.channelSales.record(command("idempotency", { requestedQuantity: 2 }), context);
    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      code: "external-channel-sale-conflict",
      differingFields: ["requestedQuantity"],
    });
    expect(await countEvents("inventory.external-channel-sale.recorded")).toBe(1);
    expect(await countEvents("inventory.item.adjusted")).toBe(1);
  });

  it("migrates the existing recovery cache and rejects a late same-fingerprint generation", async () => {
    expect(inventoryModule.schemaMigrations?.map((migration) => migration.migrationId)).toContain(
      "20260906_inventory_adjustment_claim_generation",
    );
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'inventory_item_adjustment_idempotency'
         AND column_name = 'claim_generation'`,
    );
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);

    const claim = {
      idempotencyKey: "same-fingerprint-generation",
      accountId: "acc_seller",
      itemId: "inv_external",
      commandFingerprint: "same-fingerprint",
    } as const;
    await claimInventoryAdjustmentIdempotency(pool, { ...claim, claimGeneration: "generation-a" });
    await releaseInventoryAdjustmentIdempotency(pool, { ...claim, claimGeneration: "generation-a" });
    await claimInventoryAdjustmentIdempotency(pool, { ...claim, claimGeneration: "generation-b" });
    await expect(
      completeInventoryAdjustmentIdempotency(pool, {
        idempotencyKey: claim.idempotencyKey,
        commandFingerprint: claim.commandFingerprint,
        claimGeneration: "generation-a",
        resultItemId: "inv_external",
        resultVersion: 2,
        resultCollision: null,
      }),
    ).resolves.toBe(false);
  });

  it("resumes claim-generation migration after constraint creation without a ledger receipt", async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(`CREATE TABLE inventory_item_adjustment_idempotency (
      idempotency_key text PRIMARY KEY,
      account_id text NOT NULL,
      item_id text NOT NULL,
      command_fingerprint text NOT NULL,
      status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
      result_item_id text NULL,
      result_version bigint NULL CHECK (result_version IS NULL OR result_version >= 0),
      result_collision jsonb NULL,
      created_at timestamptz NOT NULL,
      completed_at timestamptz NULL
    )`);
    await pool.query(`CREATE TABLE bounded_context_schema_migrations (
      migration_id text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await pool.query(`INSERT INTO inventory_item_adjustment_idempotency (
      idempotency_key, account_id, item_id, command_fingerprint, status, created_at
    ) VALUES ('legacy-claim', 'acc_seller', 'inv_external', 'legacy-fingerprint', 'in_progress', now())`);
    const migration = inventoryModule.schemaMigrations?.find(
      (candidate) => candidate.migrationId === "20260906_inventory_adjustment_claim_generation",
    );
    expect(migration).toBeDefined();
    for (const statement of migration!.statements.slice(0, 3)) {
      await pool.query(statement);
    }
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM bounded_context_schema_migrations WHERE migration_id = $1",
      [migration!.migrationId],
    );
    expect(before.rows).toEqual([{ count: "0" }]);

    await expect(bootstrapContextDatabase(inventoryModule, pool)).resolves.toBeUndefined();

    const row = await pool.query<{ claim_generation: string }>(
      "SELECT claim_generation FROM inventory_item_adjustment_idempotency WHERE idempotency_key = 'legacy-claim'",
    );
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'inventory_item_adjustment_idempotency'
         AND column_name = 'claim_generation'`,
    );
    const receipts = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM bounded_context_schema_migrations WHERE migration_id = $1",
      [migration!.migrationId],
    );
    expect(row.rows[0]?.claim_generation).toMatch(/^legacy:legacy-claim:/);
    expect(column.rows).toEqual([{ is_nullable: "NO" }]);
    expect(receipts.rows).toEqual([{ count: "1" }]);
  });

  it("external-channel-sale-two-line-out-of-order creates two facts for two line keys", async () => {
    for (const line of ["line-b", "line-a", "line-b", "line-a", "line-a", "line-b"]) {
      await services.channelSales.record(command(line), context);
    }
    expect(await countEvents("inventory.external-channel-sale.recorded")).toBe(2);
    expect(await countEvents("inventory.item.adjusted")).toBe(2);
  });

  it("external-channel-sale-collision-path protects orders, records shortfall, and freezes zero-applied replay", async () => {
    await seedItem("inv_zero", 3, "loc_zero");
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_order",
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "inventory.hold.placed",
          payload: {
            holdId: "hld_order",
            accountId: "acc_seller",
            itemId: "inv_zero",
            quantity: 3,
            reason: "Synthetic order commitment",
            notes: null,
            purpose: "order",
            sourceRef: { orderId: "ord_protected", reservationRequestId: "rsv_protected" },
            expiresAt: null,
          },
        },
      ],
      context,
    });
    const zeroCommand = command("zero", {
      inventoryItemId: "inv_zero",
      storageLocationId: "loc_zero",
      requestedQuantity: 4,
    });
    const zero = await services.channelSales.record(zeroCommand, context);
    expect(zero).toMatchObject({
      status: "committed",
      sale: {
        appliedQuantity: 0,
        refusedQuantity: 4,
        protectedOrderIds: ["ord_protected"],
        inventoryAdjustmentEventId: null,
        saleShortfallKey: expect.any(String),
      },
    });
    expect(await countEvents("inventory.item.adjusted", "inventory.item-inv_zero")).toBe(0);
    expect(await countEvents("inventory.item.stock-authority-claimed", "inventory.item-inv_zero")).toBe(1);
    await pool.query("DELETE FROM event_store_events WHERE stream_id = 'inventory.hold-hld_order'");
    await pool.query("DELETE FROM event_store_streams WHERE stream_id = 'inventory.hold-hld_order'");
    expect(await services.channelSales.record(zeroCommand, context)).toEqual(zero);

    await seedItem("inv_oversold", 2, "loc_oversold");
    const aboveTotal = await services.channelSales.record(
      command("above-total", {
        inventoryItemId: "inv_oversold",
        storageLocationId: "loc_oversold",
        requestedQuantity: 5,
      }),
      context,
    );
    expect(aboveTotal).toMatchObject({ status: "committed", sale: { appliedQuantity: 2, refusedQuantity: 3 } });
  });

  it("rejects empty, recorded-only, promoted-only, unexpected, wrong-version, and repeated histories", async () => {
    const emptyId = externalChannelSaleStreamId(command("empty").saleKey);
    await pool.query("INSERT INTO event_store_streams (stream_id, current_version, updated_at) VALUES ($1, 0, now())", [
      emptyId,
    ]);
    const cases = [
      ["empty", "empty-existing-stream"],
      ["recorded-only", "unknown-event"],
      ["promoted-only", "unknown-event"],
      ["unexpected", "unknown-event"],
      ["wrong-version", "unsupported-event-version"],
    ] as const;
    await appendPoison("recorded-only", "inventory.external-channel-sale.recorded-only", { eventVersion: 1 });
    await appendPoison("promoted-only", "inventory.external-channel-sale.promoted-only", { eventVersion: 1 });
    await appendPoison("unexpected", "synthetic.unexpected", { eventVersion: 1 });
    await appendPoison("wrong-version", "inventory.external-channel-sale.recorded", { eventVersion: 2 });
    for (const [line, reason] of cases) {
      await expect(services.channelSales.record(command(line), context)).resolves.toMatchObject({
        code: "external-channel-sale-history-invalid",
        reason,
      });
    }

    const repeatedCommand = command("repeated");
    await services.channelSales.record(repeatedCommand, context);
    const repeatedId = externalChannelSaleStreamId(repeatedCommand.saleKey);
    const first = await eventStore.readStream({ streamId: repeatedId });
    await eventStore.appendToStream({
      streamId: repeatedId,
      expectedVersion: 1,
      events: [{ eventType: "inventory.external-channel-sale.recorded", payload: first[0]!.payload }],
      context,
    });
    await expect(services.channelSales.record(repeatedCommand, context)).resolves.toMatchObject({
      reason: "duplicate-terminal",
      eventIndex: 1,
    });

    const trailingCommand = command("trailing");
    await services.channelSales.record(trailingCommand, context);
    const trailingId = externalChannelSaleStreamId(trailingCommand.saleKey);
    await eventStore.appendToStream({
      streamId: trailingId,
      expectedVersion: 1,
      events: [{ eventType: "synthetic.trailing", payload: {} }],
      context,
    });
    await expect(services.channelSales.record(trailingCommand, context)).resolves.toMatchObject({
      reason: "trailing-event",
      eventIndex: 1,
    });
  });

  it("rejects mismatched target, quantity, result, key, fingerprint, and stream version poison", async () => {
    const mutations = [
      ["target", "target-or-profile-mismatch", "payload = jsonb_set(payload, '{collisionMode}', '\"honor-offline\"')"],
      ["quantity", "quantity-law-failure", "payload = jsonb_set(payload, '{result,appliedQuantity}', '9')"],
      ["result", "malformed-result", "payload = jsonb_set(payload, '{result,unknown}', 'true')"],
      [
        "fingerprint",
        "stored-fingerprint-mismatch",
        `payload = jsonb_set(payload, '{commandFingerprint}', '"${"0".repeat(64)}"')`,
      ],
    ] as const;
    for (const [line, reason, assignment] of mutations) {
      const saleCommand = command(`poison-${line}`);
      await services.channelSales.record(saleCommand, context);
      const streamId = externalChannelSaleStreamId(saleCommand.saleKey);
      const before = await countEvents("inventory.item.adjusted");
      await pool.query(`UPDATE event_store_events SET ${assignment}::jsonb WHERE stream_id = $1`, [streamId]);
      await expect(services.channelSales.record(saleCommand, context)).resolves.toMatchObject({ reason });
      expect(await countEvents("inventory.item.adjusted")).toBe(before);
    }

    const keyCommand = command("poison-key");
    await services.channelSales.record(keyCommand, context);
    const keyStreamId = externalChannelSaleStreamId(keyCommand.saleKey);
    await pool.query(
      "UPDATE event_store_events SET payload = jsonb_set(payload, '{saleKey,orderLineIdentity}', '\"other-line\"') WHERE stream_id = $1",
      [keyStreamId],
    );
    await expect(services.channelSales.record(keyCommand, context)).resolves.toMatchObject({
      reason: "key-stream-mismatch",
    });

    const versionCommand = command("poison-version");
    await services.channelSales.record(versionCommand, context);
    const versionStreamId = externalChannelSaleStreamId(versionCommand.saleKey);
    await pool.query("UPDATE event_store_events SET stream_version = 2 WHERE stream_id = $1", [versionStreamId]);
    await pool.query("UPDATE event_store_streams SET current_version = 2 WHERE stream_id = $1", [versionStreamId]);
    await expect(services.channelSales.record(versionCommand, context)).resolves.toMatchObject({
      reason: "wrong-order-or-version",
    });
  });

  it("rejects non-canonical soldAt history with a matching raw fingerprint and accepts canonical UTC", async () => {
    const rawSoldAt = "2026-09-06T12:00:00-05:00";
    const poisonedCommand = command("poison-offset-sold-at", { soldAt: rawSoldAt });
    await services.channelSales.record(poisonedCommand, context);
    const streamId = externalChannelSaleStreamId(poisonedCommand.saleKey);
    const rawFingerprint = externalChannelSaleCommandFingerprint(poisonedCommand as never);
    await pool.query(
      `UPDATE event_store_events
       SET payload = jsonb_set(
         jsonb_set(payload, '{soldAt}', to_jsonb($2::text)),
         '{commandFingerprint}', to_jsonb($3::text)
       )
       WHERE stream_id = $1`,
      [streamId, rawSoldAt, rawFingerprint],
    );
    const before = await countEvents("inventory.item.adjusted");
    await expect(services.channelSales.record(poisonedCommand, context)).resolves.toMatchObject({
      code: "external-channel-sale-history-invalid",
      reason: "target-or-profile-mismatch",
    });
    expect(await countEvents("inventory.item.adjusted")).toBe(before);
    expect(await countEvents("inventory.external-channel-sale.recorded", streamId)).toBe(1);

    const canonicalCommand = command("canonical-utc", { soldAt: "2026-09-06T17:00:00.000Z" });
    const canonical = await services.channelSales.record(canonicalCommand, context);
    await expect(services.channelSales.record(canonicalCommand, context)).resolves.toEqual(canonical);
  });

  it("accepts 128-scalar event references and rejects either reference at 129", async () => {
    const reference = (marker: string, length: number) => `evt_${marker}${"x".repeat(length - 4 - marker.length)}`;
    const cases = [
      {
        line: "max-128-event-references",
        saleEventId: reference("sale-128", 128),
        inventoryAdjustmentEventId: reference("adjustment-128", 128),
        accepted: true,
      },
      {
        line: "max-129-sale-event-reference",
        saleEventId: reference("sale-129", 129),
        inventoryAdjustmentEventId: reference("adjustment-sale-control", 128),
        accepted: false,
      },
      {
        line: "max-129-adjustment-event-reference",
        saleEventId: reference("sale-adjustment-control", 128),
        inventoryAdjustmentEventId: reference("adjustment-129", 129),
        accepted: false,
      },
    ] as const;

    for (const testCase of cases) {
      const saleCommand = command(testCase.line);
      await services.channelSales.record(saleCommand, context);
      const streamId = externalChannelSaleStreamId(saleCommand.saleKey);
      await pool.query(
        `UPDATE event_store_events
         SET event_id = $2,
             payload = jsonb_set(
               jsonb_set(payload, '{result,saleEventId}', to_jsonb($2::text)),
               '{result,inventoryAdjustmentEventId}', to_jsonb($3::text)
             )
         WHERE stream_id = $1`,
        [streamId, testCase.saleEventId, testCase.inventoryAdjustmentEventId],
      );
      const before = await countEvents("inventory.item.adjusted");
      const outcome = await services.channelSales.record(saleCommand, context);
      if (testCase.accepted) {
        expect(outcome).toMatchObject({
          status: "committed",
          sale: {
            saleEventId: testCase.saleEventId,
            inventoryAdjustmentEventId: testCase.inventoryAdjustmentEventId,
          },
        });
      } else {
        expect(outcome).toMatchObject({
          code: "external-channel-sale-history-invalid",
          reason: "malformed-result",
        });
      }
      expect(await countEvents("inventory.item.adjusted")).toBe(before);
      expect(await countEvents("inventory.external-channel-sale.recorded", streamId)).toBe(1);
    }
  });

  it("external-channel-sale-crash-boundaries converges from each injected boundary", async () => {
    async function faulted(kind: "claim" | "holds" | "complete") {
      let armed = true;
      const db = {
        query: async (sql: string, values?: readonly unknown[]) => {
          const matches =
            (kind === "claim" && sql.includes("WITH inserted AS")) ||
            (kind === "holds" && sql.includes("WITH placed AS")) ||
            (kind === "complete" && sql.includes("UPDATE inventory_item_adjustment_idempotency"));
          if (armed && matches) {
            armed = false;
            throw new Error(`synthetic-${kind}-boundary`);
          }
          return pool.query(sql, values as never);
        },
      };
      const deps = {
        eventStore,
        checkpointStore: createPostgresProjectionStore({ db: pool }),
        db: db as never,
      };
      const collisions = createInventoryHoldCollisionRuntime(deps);
      return createInventoryExternalChannelSaleRuntime(deps, collisions);
    }

    for (const kind of ["claim", "holds", "complete"] as const) {
      const saleCommand = command(`crash-${kind}`);
      const runtime = await faulted(kind);
      if (kind === "complete") {
        await expect(runtime.record(saleCommand, context)).resolves.toMatchObject({ status: "committed" });
      } else {
        await expect(runtime.record(saleCommand, context)).rejects.toThrow(`synthetic-${kind}-boundary`);
      }
      await expect(services.channelSales.record(saleCommand, context)).resolves.toMatchObject({ status: "committed" });
      expect(
        await countEvents("inventory.external-channel-sale.recorded", externalChannelSaleStreamId(saleCommand.saleKey)),
      ).toBe(1);
    }
    const completed = await services.channelSales.record(command("after-complete"), context);
    expect(await services.channelSales.record(command("after-complete"), context)).toEqual(completed);
  });

  it("external-channel-sale-day-after and after-journal-retention replay from the permanent stream", async () => {
    const saleCommand = command("retention");
    const first = await services.channelSales.record(saleCommand, context);
    const streamId = externalChannelSaleStreamId(saleCommand.saleKey);
    await pool.query(
      "UPDATE inventory_item_adjustment_idempotency SET completed_at = now() - interval '91 days' WHERE idempotency_key = $1",
      [streamId],
    );
    await pool.query(
      "DELETE FROM inventory_item_adjustment_idempotency WHERE status = 'completed' AND completed_at < now() - interval '90 days'",
    );
    expect(await services.channelSales.record(saleCommand, context)).toEqual(first);
    expect(await services.channelSales.record(command("retention", { requestedQuantity: 2 }), context)).toMatchObject({
      code: "external-channel-sale-conflict",
    });
    expect(await countEvents("inventory.external-channel-sale.recorded", streamId)).toBe(1);
  });

  it("serializes concurrent fresh calls to one fact and one decrement", async () => {
    const saleCommand = command("concurrent");
    const [left, right] = await Promise.all([
      services.channelSales.record(saleCommand, context),
      services.channelSales.record(saleCommand, context),
    ]);
    expect(right).toEqual(left);
    expect(
      await countEvents("inventory.external-channel-sale.recorded", externalChannelSaleStreamId(saleCommand.saleKey)),
    ).toBe(1);
    expect(await countEvents("inventory.item.adjusted")).toBe(1);
  });
});
