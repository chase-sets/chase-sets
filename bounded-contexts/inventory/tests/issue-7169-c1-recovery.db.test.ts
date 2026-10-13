import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { EVENT_STORE_READ_PAGE_SIZE_MAX } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "..";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildInventoryHoldProjectionHandlers } from "../features/holds/read-model/projection";
import { buildInventoryItemProjectionHandlers } from "../features/inventory-items/read-model/projection";
import { randomUUID } from "node:crypto";
import {
  withInventoryMutationAttempt,
  withInventoryMutationChildAttempt,
} from "../support/runtime-support/mutation-attempt";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for C1 recovery DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_c1_synthetic" as never,
  audit: { performedByUserId: "usr_c1_synthetic" as never, forAccountId: "acc_c1_synthetic" as never },
};
const placement = {
  holdId: "hld_poison_synthetic",
  accountId: "acc_c1_synthetic",
  itemId: "inv_c1_synthetic",
  quantity: 1,
  reason: "Synthetic retained stock",
  notes: null,
  purpose: "manual",
  sourceRef: null,
  expiresAt: null,
};

describeDb("issue-7169-ac3-stock-invariants: PostgreSQL authority", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: ReturnType<typeof inventoryModule.createServices>;
  let eventStore: ReturnType<typeof createPostgresEventStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "c1_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    const discoveryPool: PgTransactionalPool = {
      ...pool,
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: <Row>(sql: string, values?: readonly unknown[]) =>
            client.query<Row>(
              process.env.CHASE_SETS_C1_MUTANT === "sql-poison-drop" && sql.includes("WITH candidates AS")
                ? sql.replace(
                    "WHERE tenant_id = $1",
                    "WHERE jsonb_typeof(payload -> 'quantity') = 'number' AND tenant_id = $1",
                  )
                : sql,
              values,
            ),
        };
      },
      query: <Row>(sql: string, values?: readonly unknown[]) =>
        pool.query<Row>(
          process.env.CHASE_SETS_C1_MUTANT === "sql-poison-drop" && sql.includes("WITH candidates AS")
            ? sql.replace(
                "WHERE tenant_id = $1",
                "WHERE jsonb_typeof(payload -> 'quantity') = 'number' AND tenant_id = $1",
              )
            : sql,
          values,
        ),
    };
    services = inventoryModule.createServices(discoveryPool, {});
    eventStore = createPostgresEventStore({ pool });
    await pool.query(`INSERT INTO inventory_storage_locations
      (storage_location_id, account_id, name, ship_from_code) VALUES
      ('loc_c1_synthetic', 'acc_c1_synthetic', 'Synthetic C1 location', 'C1')`);
    const created = await eventStore.appendToStream({
      streamId: "inventory.item-inv_c1_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_c1_synthetic",
            accountId: "acc_c1_synthetic",
            catalogItemId: "cat_c1_synthetic",
            productId: "cat_c1_synthetic::raw",
            selectedOptions: [],
            gradedCard: null,
            storageLocationId: "loc_c1_synthetic",
            totalQuantity: 1,
            acquisitionCostAmount: null,
          },
        },
      ],
    });
    const itemHandlers = buildInventoryItemProjectionHandlers(pool);
    for (const event of created) await itemHandlers[event.eventType]!(toTransportEvent(event));
  });

  const hold = () =>
    services.holds.createHold(
      {
        accountId: context.audit.forAccountId,
        itemId: "inv_c1_synthetic",
        quantity: 1,
        reason: "Synthetic concurrent hold",
        purpose: "manual",
        sourceRef: null,
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );

  async function counts() {
    return (
      await pool.query<{ event_type: string; total: string }>(
        "SELECT event_type, COUNT(*)::text AS total FROM event_store_events GROUP BY event_type ORDER BY event_type",
      )
    ).rows;
  }

  it.each([
    ["malformed quantity", { ...placement, quantity: "1" }],
    ["zero quantity", { ...placement, quantity: 0 }],
    ["negative quantity", { ...placement, quantity: -1 }],
    ["fractional quantity", { ...placement, quantity: 0.5 }],
    ["unsafe quantity", { ...placement, quantity: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown placement field", { ...placement, unknown: true }],
    ["unsupported purpose", { ...placement, purpose: "pos" }],
    ["mixed account", { ...placement, accountId: "acc_foreign_synthetic" }],
    ["mixed hold identity", { ...placement, holdId: "hld_foreign_synthetic" }],
    ["negative availability", { ...placement, quantity: 2 }],
    [
      "date-only checkout expiry",
      {
        ...placement,
        purpose: "checkout",
        sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
        expiresAt: "2026-10-12",
      },
    ],
    [
      "timezone-free checkout expiry",
      {
        ...placement,
        purpose: "checkout",
        sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
        expiresAt: "2026-10-12T12:00:00",
      },
    ],
    [
      "unknown nested source",
      {
        ...placement,
        purpose: "order",
        sourceRef: {
          orderId: "ord_synthetic",
          reservationRequestId: "rsv_synthetic",
          unknown: true,
        },
      },
    ],
  ])("rejects %s without any stock or hold append", async (_name, payload) => {
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_poison_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "inventory.hold.placed", payload }],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    await expect(
      services.items.adjustItem(
        {
          accountId: context.audit.forAccountId,
          itemId: placement.itemId,
          quantityDelta: 1,
          reason: "Synthetic poisoned intake",
        },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
    ).rejects.toThrow("reconciliation is required");
    await expect(
      services.holdCollisions.reduceItem(
        {
          accountId: "acc_c1_synthetic",
          itemId: "inv_c1_synthetic",
          requestedQuantity: 1,
          reason: "Synthetic reduction",
          mode: "protect-orders",
        },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
    ).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  const released = {
    eventType: "inventory.hold.released",
    payload: { holdId: placement.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
  };
  it("sql-poison-drop cannot satisfy the same frozen malformed-quantity assertion", async () => {
    await eventStore.appendToStream({ streamId: `inventory.hold-${placement.holdId}`, expectedVersion: "no_stream", context, events: [{ eventType: "inventory.hold.placed", payload: { ...placement, quantity: "1" } }] });
    const discriminate = async () => { await expect(hold()).rejects.toThrow("reconciliation is required"); };
    await discriminate();
    const before = await counts();
    vi.stubEnv("CHASE_SETS_C1_MUTANT", "sql-poison-drop");
    try { await expect(discriminate()).rejects.toThrow(); }
    finally { vi.unstubAllEnvs(); }
    expect(await counts()).not.toEqual(before);
  });
  it.each([
    ["missing placement", [released]],
    ["duplicate placement", [{ eventType: "inventory.hold.placed", payload: placement }]],
    ["duplicate terminal", [released, released]],
    [
      "post-terminal extension",
      [
        released,
        {
          eventType: "inventory.hold.extended",
          payload: { holdId: placement.holdId, expiresAt: "2026-10-13T12:00:00Z", extensionCount: 1 },
        },
      ],
    ],
    ["mixed terminal identity", [{ ...released, payload: { ...released.payload, holdId: "hld_foreign_synthetic" } }]],
    ["unknown terminal field", [{ ...released, payload: { ...released.payload, extra: true } }]],
    ["unknown terminal reason", [{ ...released, payload: { ...released.payload, releaseReason: "unknown" } }]],
    ["date-only terminal", [{ ...released, payload: { ...released.payload, releasedAt: "2026-10-12" } }]],
    ["unknown fact", [{ eventType: "inventory.hold.unknown", payload: { holdId: placement.holdId } }]],
  ])("rejects %s in retained complete PostgreSQL history", async (name, tail) => {
    await eventStore.appendToStream({
      streamId: `inventory.hold-${placement.holdId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        ...(name === "missing placement" ? [] : [{ eventType: "inventory.hold.placed", payload: placement }]),
        ...tail,
      ],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    await expect(
      services.items.adjustItem(
        {
          accountId: context.audit.forAccountId,
          itemId: placement.itemId,
          quantityDelta: -1,
          reason: "Synthetic poison reduction",
        },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
    ).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  it.each(["mixed tenant", "missing version", "stream-version disagreement"])(
    "fails closed for %s rather than dropping discovery rows",
    async (kind) => {
      await eventStore.appendToStream({
        streamId: `inventory.hold-${placement.holdId}`,
        expectedVersion: "no_stream",
        context,
        events: [{ eventType: "inventory.hold.placed", payload: placement }, released],
      });
      if (kind === "mixed tenant")
        await pool.query(
          "UPDATE event_store_events SET tenant_id = 'tnt_foreign_synthetic' WHERE stream_id = $1 AND stream_version = 2",
          [`inventory.hold-${placement.holdId}`],
        );
      else if (kind === "missing version")
        await pool.query("DELETE FROM event_store_events WHERE stream_id = $1 AND stream_version = 1", [
          `inventory.hold-${placement.holdId}`,
        ]);
      else
        await pool.query("UPDATE event_store_streams SET current_version = 3 WHERE stream_id = $1", [
          `inventory.hold-${placement.holdId}`,
        ]);
      const before = await counts();
      await expect(hold()).rejects.toThrow("reconciliation is required");
      expect(await counts()).toEqual(before);
    },
  );

  it("reads decisive poison beyond a complete history page and never truncates", async () => {
    const checkout = {
      ...placement,
      purpose: "checkout",
      sourceRef: { checkoutSessionId: "chk_synthetic", lineKey: "line_synthetic" },
      expiresAt: "2026-10-12T12:00:00Z",
    };
    await eventStore.appendToStream({
      streamId: `inventory.hold-${placement.holdId}`,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "inventory.hold.placed", payload: checkout },
        ...Array.from({ length: EVENT_STORE_READ_PAGE_SIZE_MAX + 5 }, (_, index) => ({
          eventType: "inventory.hold.extended",
          payload: { holdId: placement.holdId, expiresAt: "2026-10-13T12:00:00Z", extensionCount: index + 1 },
        })),
        { eventType: "inventory.hold.unknown", payload: { holdId: placement.holdId } },
      ],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  it("rejects a repeated placement and a fact after a terminal without Map or SQL cleanup", async () => {
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_poison_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "inventory.hold.placed", payload: placement },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: placement.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
        },
        { eventType: "inventory.hold.placed", payload: placement },
      ],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  it.each(["hold", "adjust"] as const)("serializes adjust versus hold with %s winning the barrier", async (winner) => {
    let entered = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    let releaseLoser!: () => void;
    const winnerFinished = new Promise<void>((resolve) => {
      releaseLoser = resolve;
    });
    const gatedPool: PgTransactionalPool = {
      ...pool,
      connect: async () => {
        const client = await pool.connect();
        let family = "";
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (sql.includes("INSERT INTO inventory_mutation_attempts")) family = String(values?.[4]);
            const result = await client.query<Row>(sql, values);
            if (sql.includes("WITH candidates AS") && entered < 2) {
              entered++;
              if (entered === 2) open();
              await barrier;
              if ((family === "hold-create" ? "hold" : "adjust") !== winner) await winnerFinished;
            }
            return result;
          },
        };
      },
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await pool.query<Row>(sql, values);
        if (sql.includes("WITH candidates AS") && entered < 2) {
          entered++;
          if (entered === 2) open();
          await barrier;
        }
        return result;
      },
    };
    services = inventoryModule.createServices(gatedPool, {});
    const runHold = () =>
      hold().finally(() => {
        if (winner === "hold") releaseLoser();
      });
    const runAdjust = () =>
      services.items
        .adjustItem(
          {
            accountId: "acc_c1_synthetic",
            itemId: "inv_c1_synthetic",
            quantityDelta: -1,
            reason: "Synthetic concurrent reduction",
          },
          withInventoryMutationAttempt(context, randomUUID()),
        )
        .finally(() => {
          if (winner === "adjust") releaseLoser();
        });
    const results = await Promise.allSettled([runHold(), runAdjust()]);
    expect(entered).toBe(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results[winner === "hold" ? 0 : 1].status).toBe("fulfilled");
    const placed = (
      await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'inventory.hold.placed'",
      )
    ).rows;
    const adjustments = (
      await pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM event_store_events WHERE event_type = 'inventory.item.adjusted'",
      )
    ).rows[0];
    expect(placed.length + Number(adjustments.total)).toBe(1);
    if (placed.length === 1) {
      const events = await eventStore.readStream({ streamId: placed[0].stream_id });
      const handlers = buildInventoryHoldProjectionHandlers(pool);
      for (const event of events) await handlers[event.eventType]!(toTransportEvent(event));
      await services.holds.releaseHold(
        { accountId: "acc_c1_synthetic", holdId: String(events[0].payload.holdId), releaseReason: "manual" },
        withInventoryMutationAttempt(context, randomUUID()),
      );
      await expect(hold()).resolves.toMatchObject({ version: 1 });
    }
  });

  it.each(["release-first", "release-last"] as const)(
    "interleaves release/adjust/hold with %s without a lost update",
    async (order) => {
      const initial = await hold();
      const handlers = buildInventoryHoldProjectionHandlers(pool);
      for (const event of await eventStore.readStream({ streamId: `inventory.hold-${initial.holdId}` }))
        await handlers[event.eventType]!(toTransportEvent(event));
      const normal = services;
      let entered = 0;
      let bothReached!: () => void;
      const reached = new Promise<void>((resolve) => {
        bothReached = resolve;
      });
      let releaseReads!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      const gatedPool: PgTransactionalPool = {
        ...pool,
        connect: async () => {
          const client = await pool.connect();
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              if (sql.includes("WITH candidates AS") && entered < 2) {
                entered++;
                if (entered === 2) bothReached();
                if (order === "release-first") await released;
              }
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      services = inventoryModule.createServices(gatedPool, {});
      const competitors = Promise.allSettled([
        hold(),
        services.items.adjustItem(
          {
            accountId: context.audit.forAccountId,
            itemId: placement.itemId,
            quantityDelta: -1,
            reason: "Synthetic interleaving reduction",
          },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
      ]);
      await reached;
      if (order === "release-last")
        expect((await competitors).every((result) => result.status === "rejected")).toBe(true);
      await normal.holds.releaseHold(
        { accountId: context.audit.forAccountId, holdId: initial.holdId, releaseReason: "manual" },
        withInventoryMutationAttempt(context, randomUUID()),
      );
      releaseReads();
      const results = await competitors;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(order === "release-first" ? 1 : 0);
      const releases = await pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM event_store_events WHERE event_type = 'inventory.hold.released'",
      );
      expect(releases.rows[0].total).toBe("1");
      services = normal;
      if (order === "release-last") await expect(hold()).resolves.toMatchObject({ version: 1 });
    },
  );

  describe("issue-7169-ac2-single-target-replay", () => {
    const location = {
      accountId: context.audit.forAccountId,
      name: " Synthetic receipt location ",
      shipFromCode: " C1 ",
      shipFromAddress: {
        name: "Synthetic",
        line1: "1 Test St",
        city: "Test",
        state: "IL",
        postalCode: "60000",
        country: "us",
      },
    };

    function attempted(id = randomUUID()) {
      return { id, context: withInventoryMutationAttempt(context, id) };
    }
    function runLocation(attempt: ReturnType<typeof attempted>, params = location) {
      return services.storageLocations.createStorageLocation(params, attempt.context);
    }

    it("recovers every production family and nested receipt without duplicating durable transport facts", async () => {
      await pool.query(
        "INSERT INTO inventory_catalog_items (catalog_item_id, status) VALUES ('cat_family_synthetic', 'active'), ('cat_ensure_synthetic', 'active')",
      );
      const replay = async <T>(family: string, call: (attempt: ReturnType<typeof attempted>) => Promise<T>) => {
        const attempt = attempted();
        const [first, concurrent] = await Promise.all([call(attempt), call(attempt)]);
        expect(concurrent).toEqual(first);
        const after = await counts();
        expect(await call(attempt)).toEqual(first);
        expect(await counts()).toEqual(after);
        expect(await services.mutations.read(attempt.id, context)).toMatchObject({ family, result: first });
        return first;
      };
      const createdLocation = await replay("location-create", (attempt) => runLocation(attempt));
      const locationParams = { ...location, storageLocationId: createdLocation.storageLocationId };
      await replay("location-update", (attempt) =>
        services.storageLocations.updateStorageLocation(
          { ...locationParams, name: "Updated synthetic" },
          attempt.context,
        ),
      );
      const item = await replay("item-create", (attempt) =>
        services.items.createItem(
          {
            accountId: context.audit.forAccountId,
            catalogItemId: "cat_family_synthetic",
            selectedOptions: [],
            storageLocationId: createdLocation.storageLocationId,
            totalQuantity: 3,
          },
          attempt.context,
        ),
      );
      await replay("item-adjust", (attempt) =>
        services.items.adjustItem(
          { accountId: context.audit.forAccountId, itemId: item.itemId, quantityDelta: 1, reason: "Synthetic intake" },
          attempt.context,
        ),
      );
      await replay("item-adjust", (attempt) =>
        services.holdCollisions.reduceItem(
          {
            accountId: context.audit.forAccountId,
            itemId: item.itemId,
            requestedQuantity: 1,
            reason: "Synthetic reduction",
            mode: "protect-orders",
          },
          attempt.context,
        ),
      );
      const placed = await replay("hold-create", (attempt) =>
        services.holds.createHold(
          {
            accountId: context.audit.forAccountId,
            itemId: item.itemId,
            quantity: 1,
            reason: "Synthetic hold",
            purpose: "manual",
            sourceRef: null,
          },
          attempt.context,
        ),
      );
      const events = await eventStore.readStream({ streamId: `inventory.hold-${placed.holdId}` });
      const handlers = buildInventoryHoldProjectionHandlers(pool);
      for (const event of events) await handlers[event.eventType]!(toTransportEvent(event));
      await replay("hold-release", (attempt) =>
        services.holds.releaseHold(
          { accountId: context.audit.forAccountId, holdId: placed.holdId, releaseReason: "manual" },
          attempt.context,
        ),
      );
      await replay("listing-stock-ensure", (attempt) =>
        services.items.ensureListingStock(
          {
            accountId: context.audit.forAccountId,
            catalogItemId: "cat_ensure_synthetic",
            selectedOptions: [],
            quantity: 2,
            shipFromAddress: location.shipFromAddress,
          },
          attempt.context,
        ),
      );
      await replay("location-archive", (attempt) =>
        services.storageLocations.updateStorageLocation({ ...locationParams, isArchived: true }, attempt.context),
      );
      const receipts = await pool.query<{ family: string; total: string }>(
        "SELECT family, COUNT(*)::text AS total FROM inventory_mutation_attempts GROUP BY family",
      );
      expect(new Set(receipts.rows.map((row) => row.family))).toEqual(
        new Set([
          "item-create",
          "item-adjust",
          "listing-stock-ensure",
          "hold-create",
          "hold-release",
          "location-create",
          "location-update",
          "location-archive",
        ]),
      );
      expect(Number(receipts.rows.find((row) => row.family === "item-create")!.total)).toBe(2);
      expect(Number(receipts.rows.find((row) => row.family === "location-archive")!.total)).toBe(2);
    });

    it("coalesces concurrent acceptance and reads the exact first result after response loss", async () => {
      const attempt = attempted();
      const [first, concurrent] = await Promise.all([runLocation(attempt), runLocation(attempt)]);
      expect(concurrent).toEqual(first);
      const normalized = {
        ...location,
        name: "Synthetic receipt location",
        shipFromCode: "C1",
        description: null,
        shipFromAddress: {
          ...location.shipFromAddress,
          country: "US",
          company: null,
          line2: null,
          phone: null,
          email: null,
          verification: null,
        },
      };
      expect(await runLocation(attempt, normalized)).toEqual(first);
      expect(await services.mutations.read(attempt.id, context)).toMatchObject({
        family: "location-create",
        result: first,
      });
      const receipt = await pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM inventory_mutation_attempts",
      );
      const facts = await pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM event_store_events WHERE event_type = 'inventory.storage-location.created'",
      );
      expect(receipt.rows[0].total).toBe("1");
      expect(facts.rows[0].total).toBe("1");
    });

    it("conflicts on changed intent, target, family or version and privately rejects changed binding", async () => {
      const attempt = attempted();
      await runLocation(attempt);
      await expect(runLocation(attempt, { ...location, name: "Changed" })).rejects.toThrow("conflicts");
      await expect(
        services.mutations.execute(
          "location-create",
          "other-draft",
          context.audit.forAccountId,
          location,
          attempt.context,
          async () => ({}),
        ),
      ).rejects.toThrow("conflicts");
      await expect(
        services.mutations.execute(
          "location-update",
          "draft",
          context.audit.forAccountId,
          { ...location, storageLocationId: "loc_other" },
          attempt.context,
          async () => ({}),
        ),
      ).rejects.toThrow("conflicts");
      await expect(
        services.mutations.execute(
          "location-create",
          "draft",
          context.audit.forAccountId,
          location,
          withInventoryMutationAttempt(context, attempt.id, 2),
          async () => ({}),
        ),
      ).rejects.toThrow("conflicts");
      const changedBindings: EventStoreContext[] = [
        { ...context, tenantId: "tnt_foreign_synthetic" },
        { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign_synthetic" } },
        { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } },
      ];
      for (const changed of changedBindings) {
        expect(await services.mutations.read(attempt.id, changed)).toBeNull();
        expect(await services.mutations.read(randomUUID(), changed)).toBeNull();
        await expect(
          services.mutations.execute(
            "location-create",
            "draft",
            changed.audit.forAccountId,
            { ...location, accountId: changed.audit.forAccountId },
            withInventoryMutationAttempt(changed, attempt.id),
            async () => ({}),
          ),
        ).rejects.toThrow("not authorized");
      }
    });

    it("joins child receipts to facts atomically and never bypasses their binding", async () => {
      const attempt = attempted();
      const child = withInventoryMutationChildAttempt(attempt.context, "location");
      const first = await services.mutations.execute(
        "listing-stock-ensure",
        "draft",
        context.audit.forAccountId,
        { accountId: context.audit.forAccountId, catalogItemId: "cat_synthetic", selectedOptions: [], quantity: 1 },
        attempt.context,
        () => services.storageLocations.createStorageLocation(location, child),
      );
      expect(
        (await pool.query<{ total: string }>("SELECT COUNT(*)::text AS total FROM inventory_mutation_attempts")).rows[0]
          .total,
      ).toBe("2");
      expect(await services.mutations.read(attempt.id, context)).toMatchObject({ result: first });
      await expect(
        services.mutations.execute(
          "listing-stock-ensure",
          "other-draft",
          context.audit.forAccountId,
          { accountId: context.audit.forAccountId, catalogItemId: "cat_synthetic", selectedOptions: [], quantity: 1 },
          withInventoryMutationChildAttempt(attempt.context, "other-parent"),
          () =>
            services.mutations.execute(
              "location-create",
              "draft",
              context.audit.forAccountId,
              { ...location, name: "Changed" },
              child,
              async () => ({}),
            ),
        ),
      ).rejects.toThrow("conflicts");
      expect(
        (await pool.query<{ total: string }>("SELECT COUNT(*)::text AS total FROM inventory_mutation_attempts")).rows[0]
          .total,
      ).toBe("2");
    });

    it.each(["acceptance", "fact", "receipt"])(
      "rolls back an interruption after %s with no partial acceptance or result",
      async (phase) => {
        const attempt = attempted();
        let interrupted = false;
        const faultPool: PgTransactionalPool = {
          query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
          connect: async () => {
            const client = await pool.connect();
            const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            const pid = backend.rows[0].pid;
            return {
              release: client.release.bind(client),
              query: async <Row>(sql: string, values?: readonly unknown[]) => {
                const result = await client.query<Row>(sql, values);
                if (
                  !interrupted &&
                  ((phase === "acceptance" && sql.includes("INSERT INTO inventory_mutation_attempts")) ||
                    (phase === "fact" && sql.includes("INSERT INTO event_store_events")) ||
                    (phase === "receipt" && sql.includes("UPDATE inventory_mutation_attempts")))
                ) {
                  interrupted = true;
                  const terminated = await pool.query<{ terminated: boolean }>(
                    "SELECT pg_terminate_backend($1) AS terminated",
                    [pid],
                  );
                  expect(terminated.rows[0].terminated).toBe(true);
                  throw new Error("Synthetic connection interruption");
                }
                return result;
              },
            };
          },
        };
        const normal = services;
        services = inventoryModule.createServices(faultPool, {});
        await expect(runLocation(attempt)).rejects.toThrow("Synthetic connection interruption");
        expect(interrupted).toBe(true);
        services = normal;
        expect(await services.mutations.read(attempt.id, context)).toBeNull();
        expect(
          (await pool.query<{ total: string }>("SELECT COUNT(*)::text AS total FROM inventory_mutation_attempts"))
            .rows[0].total,
        ).toBe("0");
        expect(
          (
            await pool.query<{ total: string }>(
              "SELECT COUNT(*)::text AS total FROM event_store_events WHERE event_type = 'inventory.storage-location.created'",
            )
          ).rows[0].total,
        ).toBe("0");
        const first = await runLocation(attempt);
        expect(await runLocation(attempt)).toEqual(first);
      },
    );
  });
});
