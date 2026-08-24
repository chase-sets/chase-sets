import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../../../index";
import { processReturnShipmentTrackingEvent } from "../../return-shipments/api/tracking-ingestion";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentEvent,
} from "../domain/domain";
import {
  executeShipmentMutationAttempt,
  shipmentMutationAttemptStreamId,
  ShipmentHistoryPoisonedError,
} from "../domain/mutation-attempt";
import {
  claimReservedPostageOperation,
  findPostageOperationByDigest,
  listStalePostageOperationLocators,
  reservePostageOperation,
  transitionPostageOperation,
} from "../read-model/postage-operation-authority";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const describeDb = adminDatabaseUrl ? describe : describe.skip;

describeDb("Shipment mutation authority (issue #7171)", () => {
  let pool: PgTransactionalPool;
  const context = {
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_seller" },
  } as EventStoreContext;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_7171");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ fulfillment: pool });
    await bootstrapContextDatabase(fulfillmentModule, pool);
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       ) VALUES ('shp_7171','tnt_1','ord_1','acc_buyer','acc_seller','standard','awaiting-label','packed',now(),now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions
       (shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at)
       VALUES ('shp_7171','tnt_1','acc_seller','resolved','authoritative-history',now())`,
    );
  });
  afterAll(async () => closeMultiContextTestPools({ fulfillment: pool }));

  function reserve(keyDigest: string, targetKey = "purchase:shp_7171:initial") {
    return reservePostageOperation(pool, {
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      shipmentId: "shp_7171",
      keyDigest,
      requestHash: `request-${keyDigest}`,
      targetKey,
      operationKind: "purchase-usps-label",
      providerName: "fake-postage",
      providerMode: "test",
      request: { serviceLevel: "USPS_GROUND_ADVANTAGE" },
    });
  }

  async function atomicHarness(shipmentId: string) {
    const eventStore = createPostgresEventStore({ pool });
    const aggregate = createAggregateCommandHandler({
      eventStore,
      codec: createPassthroughDomainEventCodec<FulfillmentShipmentEvent>(),
      initialState: () => initialFulfillmentShipmentState,
      evolve: evolveFulfillmentShipment,
      decide: decideFulfillmentShipment,
    });
    await aggregate.commandHandler({
      streamId: `fulfillment.shipment-${shipmentId}`,
      context,
      command: {
        type: "CreateShipment",
        shipmentId: shipmentId as never,
        orderId: `ord_${shipmentId}` as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot: {
          name: "Buyer",
          line1: "2 Main",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        shippingOriginSnapshot: {
          name: "Seller",
          line1: "1 Main",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        lines: [
          {
            lineId: `spl_${shipmentId}` as never,
            orderLineId: `oli_${shipmentId}`,
            catalogItemId: "cat_1",
            productId: "cat_1::",
            itemTitle: "Charizard",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-08-23T00:00:00.000Z",
      },
    });
    return { eventStore, repository: aggregate.repository };
  }

  function executeAtomic(
    harness: Awaited<ReturnType<typeof atomicHarness>>,
    input: Readonly<{ shipmentId: string; attemptId: string; eventStore?: EventStore }>,
  ) {
    return executeShipmentMutationAttempt({
      eventStore: input.eventStore ?? harness.eventStore,
      loadShipment: harness.repository.load,
      context,
      mutationAttemptId: input.attemptId,
      shipmentId: input.shipmentId,
      sellerAccountId: "acc_seller",
      commandKind: "start-packing",
      request: {},
      createCommand: () => ({ type: "StartShipmentPacking", startedAt: "2026-08-23T00:01:00.000Z" }),
      successStatus: "packing",
    });
  }

  it("issue-7171-provider-write-ahead-matrix fences invocation before a provider call and makes unknown terminally ambiguous", async () => {
    const operation = (await reserve("digest-a")).operation;
    const claim = await claimReservedPostageOperation(pool, operation, 60_000);
    expect(claim).not.toBeNull();
    const invoking = await transitionPostageOperation(pool, {
      claim: claim!,
      from: "reserved",
      to: "invoking",
      providerInvoked: true,
    });
    expect(invoking).toMatchObject({ status: "invoking", provider_invoked: true, lifecycle_generation: 1 });
    const ambiguous = await transitionPostageOperation(pool, {
      claim: claim!,
      from: "invoking",
      to: "ambiguous",
      providerInvoked: true,
      closedReason: "invocation-outcome-unknown",
    });
    expect(ambiguous).toMatchObject({ status: "ambiguous", closed_reason: "invocation-outcome-unknown" });
    expect(await claimReservedPostageOperation(pool, ambiguous!)).toBeNull();
  });

  it("issue-7171-provider-active-target-fence gives every losing UUID a non-invoking durable conflict receipt", async () => {
    const [left, right] = await Promise.all([reserve("digest-left"), reserve("digest-right")]);
    const winner = [left, right].find((entry) => !entry.targetConflict)!;
    const loser = [left, right].find((entry) => entry.targetConflict)!;
    expect(winner.operation.status).toBe("reserved");
    expect(loser.operation).toMatchObject({
      status: "failed-safe",
      closed_reason: "active-target-conflict",
      provider_invoked: false,
      provider_idempotency_key: null,
    });
    expect(await reserve(loser.operation.key_digest)).toMatchObject({ targetConflict: true, created: false });
  });

  it("issue-7171-non-provider-atomic-replay leaves no fact or receipt before appendToStreams and replays read-only after it", async () => {
    const shipmentId = "shp_atomic_cut";
    const attemptId = "018f47d2-9d2a-4d68-8f33-6fb718c3f001";
    const harness = await atomicHarness(shipmentId);
    const attemptStreamId = shipmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      key: attemptId,
    });
    const beforeCut: EventStore = {
      ...harness.eventStore,
      appendToStreams: async () => {
        throw new Error("fault-before-appendToStreams");
      },
    };
    await expect(executeAtomic(harness, { shipmentId, attemptId, eventStore: beforeCut })).rejects.toThrow(
      "fault-before-appendToStreams",
    );
    expect(await harness.eventStore.readStream({ streamId: `fulfillment.shipment-${shipmentId}` })).toHaveLength(1);
    expect(await harness.eventStore.readStream({ streamId: attemptStreamId })).toHaveLength(0);

    const afterCut: EventStore = {
      ...harness.eventStore,
      appendToStreams: async (inputs) => {
        await harness.eventStore.appendToStreams!(inputs);
        throw new Error("fault-after-appendToStreams");
      },
    };
    await expect(executeAtomic(harness, { shipmentId, attemptId, eventStore: afterCut })).rejects.toThrow(
      "fault-after-appendToStreams",
    );
    expect(await harness.eventStore.readStream({ streamId: `fulfillment.shipment-${shipmentId}` })).toHaveLength(2);
    expect(await harness.eventStore.readStream({ streamId: attemptStreamId })).toHaveLength(1);
    await expect(executeAtomic(harness, { shipmentId, attemptId })).resolves.toMatchObject({
      replayed: true,
      shipmentVersion: 2,
    });
    expect(await harness.eventStore.readStream({ streamId: `fulfillment.shipment-${shipmentId}` })).toHaveLength(2);
    expect(await harness.eventStore.readStream({ streamId: attemptStreamId })).toHaveLength(1);
  });

  it("issue-7171-non-provider-atomic-replay enforces zero-event Shipment versions and no_stream attempt guards", async () => {
    const shipmentId = "shp_atomic_guards";
    const harness = await atomicHarness(shipmentId);
    await executeAtomic(harness, {
      shipmentId,
      attemptId: "118f47d2-9d2a-4d68-8f33-6fb718c3f002",
    });
    let injectedShipmentRace = false;
    let zeroEventConflict = false;
    const zeroEventGuard: EventStore = {
      ...harness.eventStore,
      appendToStreams: async (inputs) => {
        if (!injectedShipmentRace) {
          injectedShipmentRace = true;
          await harness.eventStore.appendToStream({
            streamId: `fulfillment.shipment-${shipmentId}`,
            expectedVersion: 2,
            context,
            events: [
              {
                eventType: "fulfillment.shipment.packing-started",
                payload: { shipmentId, startedAt: "2026-08-23T00:01:01.000Z" },
              },
            ],
          });
        }
        try {
          return await harness.eventStore.appendToStreams!(inputs);
        } catch (error) {
          if ((error as { code?: string }).code === "concurrency_conflict") zeroEventConflict = true;
          throw error;
        }
      },
    };
    await expect(
      executeAtomic(harness, {
        shipmentId,
        attemptId: "218f47d2-9d2a-4d68-8f33-6fb718c3f003",
        eventStore: zeroEventGuard,
      }),
    ).resolves.toMatchObject({ resultClass: "unchanged", shipmentVersion: 3 });
    expect(zeroEventConflict).toBe(true);

    const poisonedAttemptId = "318f47d2-9d2a-4d68-8f33-6fb718c3f004";
    const poisonedAttemptStream = shipmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      key: poisonedAttemptId,
    });
    let injectedAttemptRace = false;
    let noStreamConflict = false;
    const noStreamGuard: EventStore = {
      ...harness.eventStore,
      appendToStreams: async (inputs) => {
        if (!injectedAttemptRace) {
          injectedAttemptRace = true;
          await harness.eventStore.appendToStream({
            streamId: poisonedAttemptStream,
            expectedVersion: "no_stream",
            context,
            events: [{ eventType: "fulfillment.shipment.mutation-attempt-poison.v1", payload: { schemaVersion: 999 } }],
          });
        }
        try {
          return await harness.eventStore.appendToStreams!(inputs);
        } catch (error) {
          if ((error as { code?: string }).code === "concurrency_conflict") noStreamConflict = true;
          throw error;
        }
      },
    };
    await expect(
      executeAtomic(harness, { shipmentId, attemptId: poisonedAttemptId, eventStore: noStreamGuard }),
    ).rejects.toBeInstanceOf(ShipmentHistoryPoisonedError);
    expect(noStreamConflict).toBe(true);
    expect(await harness.eventStore.readStream({ streamId: `fulfillment.shipment-${shipmentId}` })).toHaveLength(3);
    expect(await harness.eventStore.readStream({ streamId: poisonedAttemptStream })).toHaveLength(1);
  });

  it("issue-7171-read-only-recovery-route never resolves a same-seller key from another Shipment", async () => {
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       ) VALUES ('shp_7171_other','tnt_1','ord_other','acc_buyer','acc_seller','standard','awaiting-label','packed',now(),now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions
       (shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at)
       VALUES ('shp_7171_other','tnt_1','acc_seller','resolved','authoritative-history',now())`,
    );
    await reserve("digest-addressed-shipment", "purchase:shp_7171:addressed");
    await expect(
      findPostageOperationByDigest(pool, {
        tenantId: "tnt_1",
        sellerAccountId: "acc_seller",
        shipmentId: "shp_7171_other",
        keyDigest: "digest-addressed-shipment",
      }),
    ).resolves.toBeNull();
  });

  it("keeps the completed ReturnShipment webhook receipt byte-unchanged on different-hash redelivery", async () => {
    await pool.query(
      `INSERT INTO fulfillment_return_shipment_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         return_shipment_id, tracking_identifier, status, status_detail, semantic_milestone,
         occurred_at, received_at, processing_result, payload_json, payload_hash, handoff_state
       ) VALUES (
         'pev_7171_immutable','fake','test','tracking-status','trk_obj_7171',
         'rsh_7171','trk_7171','delivered',NULL,'delivered',
         '2026-08-23T00:00:00.000Z','2026-08-23T00:00:01.000Z','recorded','{}','immutable-original-hash','completed'
       )`,
    );
    const before = await pool.query<{ receipt: unknown }>(
      `SELECT to_jsonb(receipt) AS receipt FROM fulfillment_return_shipment_provider_events AS receipt
       WHERE provider_event_id = 'pev_7171_immutable'`,
    );
    const result = await processReturnShipmentTrackingEvent(
      {
        db: pool,
        commandHandler: async () => {
          throw new Error("hash mismatch must not reach command handling");
        },
        streamIdFor: (id) => `fulfillment.return-shipment-${id}`,
      },
      {
        providerEventId: "pev_7171_immutable",
        providerName: "fake",
        providerMode: "test",
        eventKind: "tracking-status",
        providerObjectReference: "trk_obj_7171",
        providerShipmentId: null,
        trackingIdentifier: "trk_7171",
        status: "delivered",
        statusDetail: "different normalized hash",
        message: null,
        occurredAt: "2026-08-23T00:00:00.000Z",
        payload: { ignoredRawProviderEnrichment: true },
      },
      context,
    );
    const after = await pool.query<{ receipt: unknown }>(
      `SELECT to_jsonb(receipt) AS receipt FROM fulfillment_return_shipment_provider_events AS receipt
       WHERE provider_event_id = 'pev_7171_immutable'`,
    );
    expect(result).toMatchObject({ status: "quarantined", processingResult: "payload-hash-mismatch" });
    expect(after.rows[0]?.receipt).toEqual(before.rows[0]?.receipt);
  });

  it("issue-7171-history-tenant-migration-bounds installs the retained tenant ledger and closed lifecycle schema", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'fulfillment_postage_label_operations'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "key_digest",
        "request_hash",
        "target_key",
        "claim_token",
        "lifecycle_generation",
      ]),
    );
    const ledger = await pool.query(
      `SELECT status, tenant_id FROM fulfillment_shipment_tenant_resolutions WHERE shipment_id = 'shp_7171'`,
    );
    expect(ledger.rows).toEqual([{ status: "resolved", tenant_id: "tnt_1" }]);
  });

  it("issue-7171-source-worker-webhook-races discovers every resolved tenant through opaque stable pagination", async () => {
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         status, package_status, created_at, updated_at
       ) VALUES ('shp_7171_b','tnt_2','ord_2','acc_buyer_2','acc_seller_2','standard','awaiting-label','packed',now(),now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_shipment_tenant_resolutions
       (shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at)
       VALUES ('shp_7171_b','tnt_2','acc_seller_2','resolved','authoritative-history',now())`,
    );
    await reserve("digest-tenant-a", "purchase:shp_7171:tenant-a");
    await reservePostageOperation(pool, {
      tenantId: "tnt_2",
      sellerAccountId: "acc_seller_2",
      shipmentId: "shp_7171_b",
      keyDigest: "digest-tenant-b",
      requestHash: "request-tenant-b",
      targetKey: "purchase:shp_7171_b:tenant-b",
      operationKind: "purchase-usps-label",
      providerName: "fake-postage",
      providerMode: "test",
      request: { serviceLevel: "USPS_GROUND_ADVANTAGE" },
    });
    const first = await listStalePostageOperationLocators(pool, {
      staleBefore: new Date(Date.now() + 60_000).toISOString(),
      limit: 1,
    });
    const second = await listStalePostageOperationLocators(pool, {
      staleBefore: new Date(Date.now() + 60_000).toISOString(),
      afterUpdatedAt: first[0]!.updatedAt,
      afterOperationId: first[0]!.operationId,
      limit: 1,
    });
    const locators = [...first, ...second];

    expect(new Set(locators.map((locator) => locator.tenantId))).toEqual(new Set(["tnt_1", "tnt_2"]));
    expect(Object.keys(locators[0]!).sort()).toEqual(["operationId", "shipmentId", "tenantId", "updatedAt"]);
    expect(JSON.stringify(locators)).not.toContain("digest-tenant");
  });
});
