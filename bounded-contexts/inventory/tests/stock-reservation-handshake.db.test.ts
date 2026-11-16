import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresOwnerStreamReservationStore,
  eventCorePostgresSchemaSql,
  initializeConfigurationConsumer,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { RequestTerminalBinding, ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "..";
import { createInventoryServices, createInventoryStockAuthorityForPool } from "../support/runtime-support/services";
import { withInventoryMutationAttempt } from "../support/runtime-support/mutation-attempt";
import { InventoryStockChangePending } from "../features/inventory-items/api/stock-reservations";
import type { InventoryStockTarget } from "../features/inventory-items/api/stock-authority";
import { reserveOrderInventoryRequest } from "../features/reservations/api/order-reservation-workflow";
import { externalChannelSaleStreamId } from "../features/channel-sales/domain/validation";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for Inventory stock reservation proof.");
const describeDb = databaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_stock",
  audit: { performedByUserId: "usr_stock", forAccountId: "acc_stock" },
};
const target: InventoryStockTarget = {
  listingId: "lst_stock",
  accountId: "acc_stock",
  inventoryItemId: "inv_stock",
  channelConnectionId: "connection-stock",
  catalogItemId: "cat_stock",
  productId: "cat_stock::raw",
  selectedOptions: [],
};
const consumer = { storeId: "stock-test-consumer", incarnation: "stock-test-incarnation" };
const now = "2026-11-15T12:00:00.000Z";
const adjustment = (delta = 1): AppendToStreamInput => ({
  streamId: "inventory.item-inv_stock",
  expectedVersion: "any",
  events: [
    {
      eventType: "inventory.item.adjusted",
      payload: { itemId: "inv_stock", quantityDelta: delta, reason: "Stock test" },
    },
  ],
  context,
});
const omissions = vi.hoisted(() => ({ physicalEnrollment: false }));
vi.mock("../features/inventory-items/api/stock-reservations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/inventory-items/api/stock-reservations")>();
  const createInventoryStockReservations: typeof actual.createInventoryStockReservations = (...args) => {
    const enrolled = actual.createInventoryStockReservations(...args);
    if (!omissions.physicalEnrollment) return enrolled;
    return {
      ...enrolled,
      persistence: args[1],
      appendInTransaction: (db, inputs) => args[1].appendToStreamsInTransaction(db, inputs),
    };
  };
  return { ...actual, createInventoryStockReservations };
});

describeDb("Inventory stock reservation handshake", () => {
  let pools: Readonly<Record<"inventory" | "marketplace", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  let store: ReturnType<typeof createPostgresEventStore>;
  let services: ReturnType<typeof createInventoryServices>;
  let authority: ReturnType<typeof createInventoryStockAuthorityForPool>;
  let protocol: ReturnType<typeof createPostgresOwnerStreamReservationStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseUrl!,
      ["inventory", "marketplace"],
      "inventory_stock_handshake",
    );
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
    consumerPool = pools.marketplace;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    await consumerPool.query(eventCorePostgresSchemaSql);
    await initializeConfigurationConsumer(consumerPool, consumer);
    store = createPostgresEventStore({ pool });
    services = createInventoryServices(pool, { stockReservationConsumerPool: consumerPool });
    authority = createInventoryStockAuthorityForPool(pool, consumerPool);
    protocol = createPostgresOwnerStreamReservationStore({
      ownerPool: pool,
      consumerPool,
      applyInvalidation: async () => undefined,
      applyInboundEvidence: async () => undefined,
    });
    await services.items.commandHandler({
      streamId: "inventory.item-inv_stock",
      command: {
        type: "CreateInventoryItem",
        itemId: "inv_stock" as never,
        accountId: "acc_stock",
        catalogItemId: "cat_stock",
        productId: "cat_stock::raw" as never,
        selectedOptions: [],
        storageLocationId: "loc_stock",
        totalQuantity: 10,
        acquisitionOccurrence: { kind: "unknown" },
        commandOccurredAt: now,
      },
      context,
    });
    await services.channelStockAllocations.set(
      {
        accountId: "acc_stock",
        inventoryItemId: "inv_stock",
        mode: "shared-pool",
        partitions: [],
        expectedRevision: 0,
      },
      context,
    );
    await services.holds.commandHandler({
      streamId: "inventory.hold-hld_stock",
      command: {
        type: "PlaceInventoryHold",
        holdId: "hld_stock" as never,
        accountId: "acc_stock",
        itemId: "inv_stock",
        quantity: 1,
        reason: "Held",
        purpose: "manual",
        sourceRef: null,
      },
      context,
    });
  });
  afterAll(async () => closeMultiContextTestPools(pools));

  async function prepare(requestId = randomUUID(), open = true): Promise<RequestTerminalBinding> {
    const capture = await authority.capture(target, context);
    const reservations = await authority.prepare(
      capture,
      {
        reservationId: `reservation-${requestId}`,
        operationId: `operation-${requestId}`,
        purpose: "listing-activation",
        consumer: { ...consumer, requestId },
        target,
        commandFingerprint: `command-${requestId}`,
      },
      context,
    );
    const binding: RequestTerminalBinding = {
      consumerStoreId: consumer.storeId,
      consumerIncarnation: consumer.incarnation,
      requestId,
      commandFingerprint: `command-${requestId}`,
      target,
      reservations,
      preparationDeadline: "2099-01-01T00:00:00.000Z",
    };
    if (open) await protocol.openRequestTerminal(binding);
    return binding;
  }
  async function commit(binding: RequestTerminalBinding) {
    return createPostgresEventStore({ pool: consumerPool }).appendToStreams!([
      {
        streamId: `test.activation-${binding.requestId}`,
        expectedVersion: "no_stream",
        events: [{ eventType: "test.activated", payload: {} }],
        context,
        requestTerminal: binding,
      },
    ]);
  }
  async function eventCount(db = pool) {
    return Number(
      (await db.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events")).rows[0].count,
    );
  }
  async function terminal(binding: RequestTerminalBinding) {
    return (
      await consumerPool.query<{ status: string }>("SELECT status FROM event_request_terminals WHERE request_id = $1", [
        binding.requestId,
      ])
    ).rows[0]?.status;
  }

  // Each route invokes the installed service or the physical append port used by its callers.
  let releaseHoldId = "hld_stock";
  const writers: ReadonlyArray<readonly [string, () => Promise<unknown>, (() => Promise<unknown>)?]> = [
    [
      "direct Item command / seed / bootstrap / reconciliation",
      () =>
        services.items.commandHandler({
          streamId: "inventory.item-inv_stock",
          command: { type: "AdjustInventoryItemQuantity", quantityDelta: 1, heldQuantity: 1, reason: "Intake" },
          context,
        }),
    ],
    [
      "positive Item adjustment / import / restock child",
      () =>
        services.items.adjustItem(
          { accountId: "acc_stock", itemId: "inv_stock", quantityDelta: 1, reason: "Intake" },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
    ],
    [
      "negative Item adjustment",
      () =>
        services.items.adjustItem(
          { accountId: "acc_stock", itemId: "inv_stock", quantityDelta: -1, reason: "Correction" },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
    ],
    [
      "atomic Item plus Hold append",
      () =>
        services.holds.createHold(
          {
            holdId: `hld_${randomUUID()}` as never,
            accountId: "acc_stock",
            itemId: "inv_stock",
            quantity: 1,
            reason: "Manual",
            purpose: "manual",
            sourceRef: null,
          },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
    ],
    [
      "Hold plan physical append",
      async () => {
        const plan = await services.holds.planCreateHold(
          {
            holdId: `hld_${randomUUID()}` as never,
            accountId: "acc_stock",
            itemId: "inv_stock",
            quantity: 1,
            reason: "Manual",
            purpose: "manual",
            sourceRef: null,
          },
          context,
        );
        if (plan.kind === "append") return services.appendToStreams(plan.appends);
      },
    ],
    [
      "Hold-only release",
      () =>
        services.holds.commandHandler({
          streamId: `inventory.hold-${releaseHoldId}`,
          command: { type: "ReleaseInventoryHold", releasedAt: now, releaseReason: "manual" },
          context,
        }),
      async () => {
        releaseHoldId = `hld_${randomUUID()}`;
        return services.holds.commandHandler({
          streamId: `inventory.hold-${releaseHoldId}`,
          command: {
            type: "PlaceInventoryHold",
            holdId: releaseHoldId as never,
            accountId: "acc_stock",
            itemId: "inv_stock",
            quantity: 1,
            reason: "Held",
            purpose: "manual",
            sourceRef: null,
          },
          context,
        });
      },
    ],
    [
      "Ordering reservation workflow physical append",
      () =>
        reserveOrderInventoryRequest(services, {
          orderId: "ord_stock",
          request: {
            reservationRequestId: `req_${randomUUID().replaceAll("-", "")}`,
            sellerAccountId: "acc_stock",
            inventoryItemId: "inv_stock",
            quantity: 1,
          },
          context,
        }),
    ],
    [
      "collision batch",
      () =>
        services.holdCollisions.reduceItem(
          { accountId: "acc_stock", itemId: "inv_stock", requestedQuantity: 1, reason: "Reduction" },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
    ],
    [
      "offline sale batch",
      () =>
        services.holdCollisions.reduceItem(
          {
            accountId: "acc_stock",
            itemId: "inv_stock",
            requestedQuantity: 1,
            reason: "Offline",
            mode: "honor-offline",
            actorRole: "owner",
            offlineSale: { idempotencyKey: randomUUID(), salePriceAmount: null, channel: "other" },
          },
          withInventoryMutationAttempt(context, randomUUID()),
        ),
    ],
    [
      "allocation set",
      async () => {
        const allocation = await services.channelStockAllocations.readAuthoritative({
          accountId: target.accountId,
          inventoryItemId: target.inventoryItemId,
        });
        if ("code" in allocation) throw new Error(allocation.code);
        return services.channelStockAllocations.set(
          {
            accountId: "acc_stock",
            inventoryItemId: "inv_stock",
            mode: "partitioned",
            partitions: [{ channelConnectionId: "connection-stock", units: 2 }],
            expectedRevision: allocation.revision,
          },
          context,
        );
      },
    ],
    [
      "retained replay and aliased append",
      () => {
        const append = services.appendToStreams;
        return append([adjustment()]);
      },
    ],
  ];

  it.each(writers.map(([name, write, setup]) => ({ name, write, setup })))(
    "$name: abort-first, terminal-first, unknown and enrollment omission",
    async ({ write, setup }) => {
      await setup?.();
      const first = await prepare();
      await write();
      expect(await terminal(first)).toBe("ABORTED");
      const beforeConsumer = await eventCount(consumerPool);
      await expect(commit(first)).rejects.toMatchObject({ code: "concurrency_conflict" });
      expect(await eventCount(consumerPool)).toBe(beforeConsumer);

      await setup?.();
      const newer = await prepare();
      await commit(newer);
      expect(await terminal(newer)).toBe("COMMITTED");
      await write();
      expect((await protocol.getReservation(newer.reservations[0].reservationId))?.releaseStatus).toBe("COMMITTED");

      await setup?.();
      const unknown = await prepare(randomUUID(), false);
      const before = await eventCount();
      await expect(write()).rejects.toBeInstanceOf(InventoryStockChangePending);
      expect(await eventCount()).toBe(before);
      expect((await authority.status("inventory.item-inv_stock"))?.status).not.toBe("APPLIED");
      // Named omission switch: bypass this writer's shared physical fence, not a modeled callback.
      const enrolledServices = services;
      omissions.physicalEnrollment = true;
      services = createInventoryServices(pool, { stockReservationConsumerPool: consumerPool });
      omissions.physicalEnrollment = false;
      try {
        await write();
      } finally {
        services = enrolledServices;
      }
      const mutantEvents = await eventCount();
      expect(mutantEvents).toBeGreaterThan(before);
      await protocol.openRequestTerminal(unknown);
      await commit(unknown);
      expect(await terminal(unknown)).toBe("COMMITTED");
      // The candidate's zero-event/abort predicate is red under the mechanism mutant.
      expect(() => expect(mutantEvents).toBe(before)).toThrow();
    },
  );

  it("records inbound sale before an unknown abort, survives restart, then settles exactly once", async () => {
    const binding = await prepare(randomUUID(), false);
    const command = {
      accountId: "acc_stock",
      inventoryItemId: "inv_stock",
      storageLocationId: "loc_stock",
      requestedQuantity: 2,
      saleKey: {
        version: "v1" as const,
        providerKey: "external",
        sellerEnvironmentLineage: "synthetic-stock",
        orderLineIdentity: "line-stock",
      },
    };
    const id = externalChannelSaleStreamId(command.saleKey);
    const before = await eventCount();
    await expect(services.channelSales.record(command, context)).rejects.toBeInstanceOf(InventoryStockChangePending);
    expect(await eventCount()).toBe(before);
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1",
          [id],
        )
      ).rows[0].status,
    ).toBe("PENDING");
    await protocol.openRequestTerminal(binding);
    const restarted = createInventoryStockAuthorityForPool(pool, consumerPool);
    expect(await restarted.settleInboundSale(id)).toMatchObject({ status: "committed", sale: { appliedQuantity: 2 } });
    expect(await terminal(binding)).toBe("ABORTED");
    const after = await eventCount();
    expect(await restarted.settleInboundSale(id)).toMatchObject({ status: "committed" });
    expect(await eventCount()).toBe(after);
    expect(
      (
        await pool.query<{ status: string }>(
          "SELECT status FROM event_owner_stream_inbound_evidence WHERE evidence_id = $1",
          [id],
        )
      ).rows[0].status,
    ).toBe("APPLIED");
  });

  it("captures Hold-aware canonical stock with all projections poisoned and rejects stale Hold captures", async () => {
    await pool.query(
      "DELETE FROM inventory_items; DELETE FROM inventory_holds; DELETE FROM inventory_channel_stock_allocations",
    );
    const captured = await authority.capture(target, context);
    expect(captured.stock).toMatchObject({ totalQuantity: 10, heldQuantity: 1, availableQuantity: 9 });
    await services.holds.commandHandler({
      streamId: "inventory.hold-hld_stock",
      command: { type: "ReleaseInventoryHold", releasedAt: now, releaseReason: "manual" },
      context,
    });
    const input = {
      reservationId: "stale-hold",
      operationId: "stale-hold",
      purpose: "activation",
      consumer: { ...consumer, requestId: "stale-hold" },
      target,
      commandFingerprint: "stale-hold",
    };
    await expect(authority.prepare(captured, input, context)).rejects.toThrow("no longer current");
    // Omit canonical recapture: unchanged physical seals alone incorrectly admit the stale Hold snapshot.
    await expect(
      protocol.reserve({
        ...input,
        ownerStreamId: "inventory.item-inv_stock",
        resourceKey: "stock/acc_stock/inv_stock",
        seal: { version: captured.itemVersion, storeIncarnation: captured.incarnation },
      }),
    ).resolves.toMatchObject({ status: "OPEN" });
  });

  it("closes both old and new account scopes of an owner transfer", async () => {
    const old = await prepare();
    const capture = await authority.capture(target, context);
    const newReservation: ReserveOwnerStreamInput = {
      ...old.reservations[1],
      reservationId: "new-account",
      operationId: "new-account",
      consumer: { ...consumer, requestId: "new-account" },
      resourceKey: "stock/acc_new/inv_stock",
      target: { ...target, accountId: "acc_new" },
      seal: { version: capture.itemVersion, storeIncarnation: capture.incarnation },
      commandFingerprint: "new-account",
    };
    await protocol.reserve(newReservation);
    const next: RequestTerminalBinding = {
      ...old,
      requestId: "new-account",
      reservations: [newReservation],
      target: newReservation.target,
      commandFingerprint: newReservation.commandFingerprint,
    };
    await protocol.openRequestTerminal(next);
    await services.appendToStreams([
      { ...adjustment(), context: { ...context, audit: { ...context.audit, forAccountId: "acc_new" } } },
    ]);
    expect(await terminal(old)).toBe("ABORTED");
    expect(await terminal(next)).toBe("ABORTED");
  });

  it.each(["fingerprint", "target", "incarnation", "version"])(
    "rejects changed %s bindings without a reservation",
    async (fault) => {
      const capture = await authority.capture(target, context);
      const changed =
        fault === "incarnation"
          ? { ...capture, incarnation: "foreign" }
          : fault === "version"
            ? { ...capture, itemVersion: capture.itemVersion + 1 }
            : capture;
      const input = {
        reservationId: "binding",
        operationId: "binding",
        purpose: "activation",
        consumer: { ...consumer, requestId: "binding" },
        target: fault === "target" ? { ...target, listingId: "foreign" } : target,
        commandFingerprint: "binding",
      };
      if (fault === "fingerprint") {
        await authority.prepare(capture, input, context);
        await expect(
          authority.prepare(capture, { ...input, commandFingerprint: "changed" }, context),
        ).rejects.toMatchObject({ code: "concurrency_conflict" });
      } else await expect(authority.prepare(changed, input, context)).rejects.toThrow();
    },
  );
});
