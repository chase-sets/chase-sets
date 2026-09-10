import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PostageOperationSubjectKind, PostageProviderWebhookEvent } from "@chase-sets/postage-labels";
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
  executeFulfillmentMutationAttempt,
  fulfillmentMutationAttemptStreamId,
  ShipmentHistoryPoisonedError,
} from "../domain/mutation-attempt";
import {
  claimReservedPostageOperation,
  findPostageOperationByDigest,
  listStalePostageOperationLocators,
  reservePostageOperation,
  transitionPostageOperation,
} from "../read-model/postage-operation-authority";
import { buildFulfillmentShipmentProjectionHandlers } from "../read-model/projection";
import { createFulfillmentShipmentRuntime } from "./runtime";

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
      subjectKind: "shipment",
      subjectId: "shp_7171",
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
    return executeFulfillmentMutationAttempt({
      eventStore: input.eventStore ?? harness.eventStore,
      loadShipment: harness.repository.load,
      context,
      mutationAttemptId: input.attemptId,
      subjectKind: "shipment",
      subjectId: input.shipmentId,
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

  it("postage-subject-fence admits one provider invocation per subject kind and its fence-removed mutant admits two", async () => {
    const subjectKinds: readonly PostageOperationSubjectKind[] = [
      "shipment",
      "return-shipment",
      "channel-fulfillment-record",
    ];

    async function attemptPurchase(
      subjectKind: PostageOperationSubjectKind,
      subjectId: string,
      key: string,
      providerInvocation: (input: { subjectKind: PostageOperationSubjectKind; subjectId: string }) => Promise<unknown>,
    ) {
      const inserted = await pool.query(
        `INSERT INTO fulfillment_postage_label_operations (
           operation_key, operation_id, operation_kind, subject_kind, subject_id,
           tenant_id, seller_account_id, key_digest, request_hash, target_key,
           provider_name, provider_mode, idempotency_key, status, created_at, updated_at
         ) VALUES (
           $1, $2, 'purchase-usps-label', $3, $4,
           'tnt_fence', 'acc_fence', $5, $5, 'purchase:initial',
           'fake-postage', 'test', $5, 'reserved', now(), now()
         )
         ON CONFLICT DO NOTHING
         RETURNING operation_key`,
        [`operation-${key}`, `pop-${key}`, subjectKind, subjectId, key],
      );
      if (inserted.rows[0]) await providerInvocation({ subjectKind, subjectId });
    }

    for (const subjectKind of subjectKinds) {
      await pool.query(`DELETE FROM fulfillment_postage_label_operations`);
      const subjectId = `same-${subjectKind}`;
      const providerInvocation = vi.fn(async () => undefined);
      await Promise.all([
        attemptPurchase(subjectKind, subjectId, `${subjectKind}-left`, providerInvocation),
        attemptPurchase(subjectKind, subjectId, `${subjectKind}-right`, providerInvocation),
      ]);
      expect(providerInvocation, subjectKind).toHaveBeenCalledTimes(1);
    }

    await pool.query(`DELETE FROM fulfillment_postage_label_operations`);
    await pool.query(`DROP INDEX fulfillment_postage_label_operations_active_target_v2_idx`);
    try {
      const mutantProviderInvocation = vi.fn(async () => undefined);
      await Promise.all([
        attemptPurchase("shipment", "mutant-subject", "mutant-left", mutantProviderInvocation),
        attemptPurchase("shipment", "mutant-subject", "mutant-right", mutantProviderInvocation),
      ]);
      expect(mutantProviderInvocation).toHaveBeenCalledTimes(2);
    } finally {
      await pool.query(`DELETE FROM fulfillment_postage_label_operations`);
      await pool.query(
        `CREATE UNIQUE INDEX fulfillment_postage_label_operations_active_target_v2_idx
         ON fulfillment_postage_label_operations (
           tenant_id, seller_account_id, subject_kind, subject_id, operation_kind, target_key
         )
         WHERE status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied')`,
      );
    }
  });

  it("postage-subject-tenant-authority refuses absent and quarantined record tenants before provider effects", async () => {
    await pool.query(
      `INSERT INTO fulfillment_channel_fulfillment_record_tenant_resolutions (
         channel_fulfillment_record_id, tenant_id, seller_account_id, status, reason_code, resolved_at
       ) VALUES ('cfr_quarantined', NULL, NULL, 'quarantined', 'projection-identity-mismatch', now())`,
    );
    const providerInvocation = vi.fn(async () => undefined);
    async function attemptRecord(subjectId: string, keyDigest: string) {
      const reservation = await reservePostageOperation(pool, {
        tenantId: "tnt_1",
        sellerAccountId: "acc_seller",
        subjectKind: "channel-fulfillment-record",
        subjectId,
        keyDigest,
        requestHash: keyDigest,
        targetKey: `purchase:${subjectId}:initial`,
        operationKind: "purchase-usps-label",
        providerName: "fake-postage",
        providerMode: "test",
        request: { subjectKind: "channel-fulfillment-record", subjectId },
      });
      if (!reservation.targetConflict) await providerInvocation();
    }

    await expect(attemptRecord("cfr_absent", "absent-key")).rejects.toThrow("tenant authority is unavailable");
    await expect(attemptRecord("cfr_quarantined", "quarantined-key")).rejects.toThrow(
      "tenant authority is unavailable",
    );
    expect(providerInvocation).not.toHaveBeenCalled();
    const operations = await pool.query(
      `SELECT operation_key FROM fulfillment_postage_label_operations
       WHERE subject_kind = 'channel-fulfillment-record'`,
    );
    expect(operations.rows).toEqual([]);
  });

  it("projects record tenant identity with the Shipment projection's resolved and quarantined semantics", async () => {
    const handlers = buildFulfillmentShipmentProjectionHandlers(pool);
    const created = {
      type: "fulfillment.channel-fulfillment-record.created",
      tenantId: "tnt_1",
      data: {
        channelFulfillmentRecordId: "cfr_projection",
        sellerAccountId: "acc_seller",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    };
    await handlers["fulfillment.channel-fulfillment-record.created"]!(created as never);
    expect(
      (
        await pool.query(
          `SELECT tenant_id, seller_account_id, status, reason_code
           FROM fulfillment_channel_fulfillment_record_tenant_resolutions
           WHERE channel_fulfillment_record_id = 'cfr_projection'`,
        )
      ).rows,
    ).toEqual([
      {
        tenant_id: "tnt_1",
        seller_account_id: "acc_seller",
        status: "resolved",
        reason_code: "authoritative-history",
      },
    ]);

    await handlers["fulfillment.channel-fulfillment-record.created"]!({
      ...created,
      tenantId: "tnt_other",
    } as never);
    expect(
      (
        await pool.query(
          `SELECT status, reason_code
           FROM fulfillment_channel_fulfillment_record_tenant_resolutions
           WHERE channel_fulfillment_record_id = 'cfr_projection'`,
        )
      ).rows,
    ).toEqual([{ status: "quarantined", reason_code: "projection-identity-mismatch" }]);
  });

  it("postage-subject-webhook-resolution resolves shipment and record subjects and quarantines ambiguity", async () => {
    await pool.query(
      `UPDATE fulfillment_shipment_pages
       SET tracking_identifier = 'trk_shipment', postage_provider_shipment_id = 'eps_shipment'
       WHERE shipment_id = 'shp_7171'`,
    );
    await pool.query(
      `INSERT INTO fulfillment_channel_fulfillment_record_tenant_resolutions (
         channel_fulfillment_record_id, tenant_id, seller_account_id, status, reason_code, resolved_at
       ) VALUES ('cfr_webhook', 'tnt_1', 'acc_seller', 'resolved', 'authoritative-history', now())`,
    );
    await pool.query(
      `INSERT INTO fulfillment_postage_label_operations (
         operation_key, operation_id, operation_kind, subject_kind, subject_id,
         tenant_id, seller_account_id, key_digest, request_hash, target_key,
         provider_name, provider_mode, idempotency_key, status,
         provider_shipment_id, tracking_identifier, created_at, updated_at
       ) VALUES (
         'record-webhook-operation', 'pop_record_webhook', 'purchase-usps-label',
         'channel-fulfillment-record', 'cfr_webhook', 'tnt_1', 'acc_seller',
         'record-webhook-key', 'record-webhook-request', 'purchase:initial',
         'fake-postage', 'test', 'record-webhook-key', 'effect-applied',
         'eps_record', 'trk_record', now(), now()
       )`,
    );
    const shipmentHarness = await atomicHarness("shp_7171");

    async function process(event: PostageProviderWebhookEvent) {
      const services = createFulfillmentShipmentRuntime({
        eventStore: shipmentHarness.eventStore,
        checkpointStore: {} as never,
        db: pool,
        postageWebhookGateway: { processPostageProviderWebhook: async () => event },
      });
      return services.processPostageProviderWebhook(
        { rawBody: "{}", method: "POST", path: "/postage/webhooks", headers: new Headers() },
        context,
      );
    }

    const baseEvent = {
      providerName: "fake-postage",
      providerMode: "test",
      eventKind: "tracking-status",
      providerObjectReference: "tracker",
      status: "in_transit",
      occurredAt: "2026-09-10T01:00:00.000Z",
      payload: {},
    } as const;
    await expect(
      process({
        ...baseEvent,
        providerEventId: "pev_subject_shipment",
        providerShipmentId: "eps_shipment",
        trackingIdentifier: "trk_shipment",
      }),
    ).resolves.toMatchObject({
      status: "recorded",
      subjectKind: "shipment",
      subjectId: "shp_7171",
      shipmentId: "shp_7171",
    });
    await expect(
      process({
        ...baseEvent,
        providerEventId: "pev_subject_record",
        providerShipmentId: "eps_record",
        trackingIdentifier: "trk_record",
      }),
    ).resolves.toMatchObject({
      status: "recorded",
      subjectKind: "channel-fulfillment-record",
      subjectId: "cfr_webhook",
      shipmentId: null,
    });

    await pool.query(
      `UPDATE fulfillment_shipment_pages SET tracking_identifier = 'trk_ambiguous'
       WHERE shipment_id = 'shp_7171'`,
    );
    await pool.query(
      `UPDATE fulfillment_postage_label_operations SET tracking_identifier = 'trk_ambiguous'
       WHERE operation_key = 'record-webhook-operation'`,
    );
    await expect(
      process({
        ...baseEvent,
        providerEventId: "pev_subject_ambiguous",
        providerShipmentId: null,
        trackingIdentifier: "trk_ambiguous",
      }),
    ).resolves.toMatchObject({
      status: "recorded",
      shipmentId: null,
      processingResult: "quarantined",
    });
    const receipts = await pool.query<{
      provider_event_id: string;
      subject_kind: string | null;
      subject_id: string | null;
      processing_result: string;
    }>(
      `SELECT provider_event_id, subject_kind, subject_id, processing_result
       FROM fulfillment_postage_provider_events
       WHERE provider_event_id LIKE 'pev_subject_%'
       ORDER BY provider_event_id`,
    );
    expect(receipts.rows).toEqual([
      {
        provider_event_id: "pev_subject_ambiguous",
        subject_kind: null,
        subject_id: null,
        processing_result: "multiple-authority-matches",
      },
      {
        provider_event_id: "pev_subject_record",
        subject_kind: "channel-fulfillment-record",
        subject_id: "cfr_webhook",
        processing_result: "recorded",
      },
      {
        provider_event_id: "pev_subject_shipment",
        subject_kind: "shipment",
        subject_id: "shp_7171",
        processing_result: "recorded",
      },
    ]);
  });

  it("records unresolved provider events with nullable subjects and unchanged unmatched processing", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const services = createFulfillmentShipmentRuntime({
      eventStore,
      checkpointStore: {} as never,
      db: pool,
      postageWebhookGateway: {
        processPostageProviderWebhook: async () => ({
          providerEventId: "pev_unresolved_subject",
          providerName: "fake-postage",
          providerMode: "test",
          eventKind: "provider-event",
          providerObjectReference: "unknown-provider-object",
          providerShipmentId: null,
          trackingIdentifier: null,
          occurredAt: "2026-09-10T02:00:00.000Z",
          payload: {},
        }),
      },
    });

    await expect(
      services.processPostageProviderWebhook(
        { rawBody: "{}", method: "POST", path: "/postage/webhooks", headers: new Headers() },
        context,
      ),
    ).resolves.toMatchObject({ processingResult: "unmatched", subjectKind: null, subjectId: null });
    const receipt = await pool.query(
      `SELECT subject_kind, subject_id, processing_result, handoff_state
       FROM fulfillment_postage_provider_events
       WHERE provider_event_id = 'pev_unresolved_subject'`,
    );
    expect(receipt.rows).toEqual([
      { subject_kind: null, subject_id: null, processing_result: "unmatched", handoff_state: "unmatched" },
    ]);
  });

  it("issue-7171-non-provider-atomic-replay leaves no fact or receipt before appendToStreams and replays read-only after it", async () => {
    const shipmentId = "shp_atomic_cut";
    const attemptId = "018f47d2-9d2a-4d68-8f33-6fb718c3f001";
    const harness = await atomicHarness(shipmentId);
    const attemptStreamId = fulfillmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      subjectKind: "shipment",
      subjectId: shipmentId,
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
      subjectVersion: 2,
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
    ).resolves.toMatchObject({ resultClass: "unchanged", subjectVersion: 3 });
    expect(zeroEventConflict).toBe(true);

    const poisonedAttemptId = "318f47d2-9d2a-4d68-8f33-6fb718c3f004";
    const poisonedAttemptStream = fulfillmentMutationAttemptStreamId({
      tenantId: "tnt_1",
      sellerAccountId: "acc_seller",
      subjectKind: "shipment",
      subjectId: shipmentId,
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
        subjectKind: "shipment",
        subjectId: "shp_7171_other",
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
      subjectKind: "shipment",
      subjectId: "shp_7171_b",
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
    expect(Object.keys(locators[0]!).sort()).toEqual([
      "operationId",
      "subjectId",
      "subjectKind",
      "tenantId",
      "updatedAt",
    ]);
    expect(JSON.stringify(locators)).not.toContain("digest-tenant");
  });
});
