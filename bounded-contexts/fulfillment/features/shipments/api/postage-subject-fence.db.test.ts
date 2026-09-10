import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider, PurchasedPostageLabel } from "@chase-sets/postage-labels";
import { module as fulfillmentModule } from "../../../index";
import { createReturnFacilityDirectory } from "../../return-shipments/domain/facility-directory";
import {
  createReturnShipmentLabelPurchaseService,
  type ReturnLabelDirective,
} from "../../return-shipments/api/label-purchase";
import {
  claimReservedPostageOperation,
  reservePostageOperation,
  transitionPostageOperation,
} from "../read-model/postage-operation-authority";
import { createFulfillmentShipmentRuntime } from "./runtime";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const context: EventStoreContext = {
  tenantId: "tnt_fence" as never,
  audit: { performedByUserId: "usr_fence" as never, forAccountId: "acc_fence" as never },
};

const activeTargetV2IndexSql = `CREATE UNIQUE INDEX fulfillment_postage_label_operations_active_target_v2_idx
  ON fulfillment_postage_label_operations (
    tenant_id, seller_account_id, subject_kind, subject_id, operation_kind, target_key
  )
  WHERE status IN ('reserved', 'invoking', 'ambiguous', 'provider-succeeded', 'effect-applied')`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(assertion: () => Promise<boolean> | boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await assertion()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Concurrent postage test did not reach its expected deterministic checkpoint.");
}

function purchasedLabel(subjectId: string, invocation: number): PurchasedPostageLabel {
  const suffix = `${subjectId}-${invocation}`.replace(/[^a-zA-Z0-9]/g, "");
  return {
    providerName: "synthetic-postage",
    providerMode: "test",
    providerShipmentId: `pshp_${suffix}`,
    providerLabelId: `plbl_${suffix}`,
    providerRateId: `rate_${suffix}`,
    carrierName: "USPS",
    serviceLevel: "USPS_GROUND_ADVANTAGE",
    labelReference: `label_${suffix}`,
    labelDocumentUrl: `https://synthetic.invalid/${suffix}.pdf`,
    trackingIdentifier: `tracking_${suffix}`,
    postageAmountCents: 499,
    postageCurrency: "USD",
    purchasedAt: "2026-09-10T00:05:00.000Z",
  };
}

function gatedProvider(pool: PgTransactionalPool, gate: ReturnType<typeof deferred>) {
  const observedReservations: Array<Readonly<{ subjectKind: string; subjectId: string; status: string }>> = [];
  const provider: PostageLabelProvider = {
    providerName: "synthetic-postage",
    providerMode: "test",
    purchaseUspsLabel: vi.fn(async (request) => {
      const reservation =
        request.subjectKind === "return-shipment"
          ? await pool.query<{ status: string }>(
              `SELECT status FROM fulfillment_return_shipment_label_operations
               WHERE operation_key = $1`,
              [request.idempotencyKey],
            )
          : await pool.query<{ status: string }>(
              `SELECT status FROM fulfillment_postage_label_operations
               WHERE provider_idempotency_key = $1`,
              [request.idempotencyKey],
            );
      const status = reservation.rows[0]?.status;
      if (!status) throw new Error("Synthetic provider effect ran before its durable reservation.");
      observedReservations.push({ subjectKind: request.subjectKind, subjectId: request.subjectId, status });
      const invocation = vi.mocked(provider.purchaseUspsLabel).mock.calls.length;
      await gate.promise;
      return purchasedLabel(request.subjectId, invocation);
    }),
    voidLabel: vi.fn(async () => ({
      providerName: "synthetic-postage",
      providerMode: "test",
      refundReference: "refund_synthetic",
      refundStatus: "submitted",
      voidedAt: "2026-09-10T00:10:00.000Z",
    })),
  };
  return { provider, observedReservations };
}

async function createPackedShipmentRuntime(
  pool: PgTransactionalPool,
  shipmentId: string,
  provider: PostageLabelProvider,
) {
  const eventStore = createPostgresEventStore({ pool });
  const services = createFulfillmentShipmentRuntime({
    eventStore,
    checkpointStore: {} as never,
    db: pool,
    postageLabelProvider: provider,
  });
  const streamId = `fulfillment.shipment-${shipmentId}`;
  await services.commandHandler({
    streamId,
    command: {
      type: "CreateShipment",
      shipmentId: shipmentId as never,
      orderId: `ord_${shipmentId}` as never,
      buyerAccountId: "acc_buyer" as never,
      sellerAccountId: "acc_fence" as never,
      shippingOption: "standard",
      shippingDestinationSnapshot: {
        name: "Synthetic Buyer",
        line1: "2 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      },
      shippingOriginSnapshot: {
        name: "Synthetic Seller",
        line1: "1 Test St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      shippingPlanSnapshot: null,
      lines: [
        {
          lineId: `spl_${shipmentId}` as never,
          orderLineId: `oli_${shipmentId}`,
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          itemTitle: "Synthetic card",
          itemSubtitle: null,
          productSummary: null,
          quantity: 1,
        },
      ],
      createdAt: "2026-09-10T00:00:00.000Z",
    },
    context,
  });
  await services.commandHandler({
    streamId,
    command: { type: "StartShipmentPacking", startedAt: "2026-09-10T00:01:00.000Z" },
    context,
  });
  await services.commandHandler({
    streamId,
    command: {
      type: "ConfirmShipmentPackingLine",
      lineId: `spl_${shipmentId}` as never,
      confirmedAt: "2026-09-10T00:02:00.000Z",
    },
    context,
  });
  await services.commandHandler({
    streamId,
    command: { type: "PrepareShipmentPackage", packageCount: 1, preparedAt: "2026-09-10T00:03:00.000Z" },
    context,
  });
  await pool.query(
    `INSERT INTO fulfillment_shipment_pages (
       shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
       shipping_destination_snapshot, shipping_origin_snapshot, status, package_status, created_at, updated_at
     ) VALUES ($1, 'tnt_fence', $2, 'acc_buyer', 'acc_fence', 'standard', $3, $4,
               'awaiting-label', 'packed', '2026-09-10T00:00:00.000Z', '2026-09-10T00:03:00.000Z')`,
    [
      shipmentId,
      `ord_${shipmentId}`,
      JSON.stringify({
        name: "Synthetic Buyer",
        line1: "2 Test St",
        city: "Chicago",
        state: "IL",
        postalCode: "60601",
        country: "US",
      }),
      JSON.stringify({
        name: "Synthetic Seller",
        line1: "1 Test St",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      }),
    ],
  );
  await pool.query(
    `INSERT INTO fulfillment_shipment_tenant_resolutions (
       shipment_id, tenant_id, seller_account_id, status, reason_code, resolved_at
     ) VALUES ($1, 'tnt_fence', 'acc_fence', 'resolved', 'authoritative-history', now())`,
    [shipmentId],
  );
  return services;
}

function purchaseShipment(
  services: Awaited<ReturnType<typeof createPackedShipmentRuntime>>,
  shipmentId: string,
  mutationAttemptId: string,
) {
  return services.purchaseUspsLabel(
    {
      shipmentId,
      sellerAccountId: "acc_fence",
      serviceLevel: "USPS_GROUND_ADVANTAGE",
      package: { mailpieceClass: "parcel", lengthInches: 9, widthInches: 6, heightInches: 2, weightOunces: 10 },
      mutationAttemptId,
    },
    context,
  );
}

function returnDirective(returnShipmentId: string): ReturnLabelDirective {
  return {
    returnShipmentId: returnShipmentId as never,
    remedyId: `rmd_${returnShipmentId}` as never,
    supportRequestId: `sup_${returnShipmentId}` as never,
    orderId: `ord_${returnShipmentId}` as never,
    outboundShipmentId: `shp_${returnShipmentId}` as never,
    affectedOrderLineIds: [`oli_${returnShipmentId}`],
    returnProgram: "platform-custody",
    carrier: "usps",
    region: "us-east",
    serviceLevel: "USPS_GROUND_ADVANTAGE",
    shipFromSnapshot: {
      name: "Synthetic Buyer",
      line1: "2 Test St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    packageRequirements: { weightOunces: 10, lengthInches: 9, widthInches: 6, heightInches: 2 },
    costPayer: "platform",
    costAllocationReference: "synthetic-allocation",
    estimatedPostageAmountCents: 450,
    selectionPolicyVersion: "synthetic-facility-v1",
    shipByDeadlineAt: "2026-09-20T00:00:00.000Z",
    returnByDeadlineAt: "2026-09-30T00:00:00.000Z",
    policyVersion: "synthetic-return-v1",
    idempotencyKey: `authorization-${returnShipmentId}`,
  };
}

function createReturnService(pool: PgTransactionalPool, provider: PostageLabelProvider) {
  const eventStore = createPostgresEventStore({ pool });
  return createReturnShipmentLabelPurchaseService({
    eventStore,
    db: pool,
    postageLabelProvider: provider,
    facilityDirectory: createReturnFacilityDirectory([
      {
        facilityId: "fac_synthetic",
        configVersion: "v1",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        supportedReturnPrograms: ["platform-custody"],
        supportedCarriers: ["usps"],
        supportedRegions: ["us-east"],
        packageConstraints: { maxWeightOunces: 80, maxLengthInches: 24, maxWidthInches: 18, maxHeightInches: 12 },
        postalAddress: {
          name: "Synthetic Returns",
          line1: "100 Test Dock",
          city: "Newark",
          state: "NJ",
          postalCode: "07102",
          country: "US",
        },
        restrictedRouting: { operationalContact: "synthetic@invalid", internalRoutingCode: "TEST" },
        displayName: "Synthetic Returns",
        displayInstructions: "Test only.",
      },
    ]),
    loadLinkageSource: async (linkage) => ({
      supportOrderId: linkage.orderId,
      supportAffectedOrderLineIds: linkage.affectedOrderLineIds,
      remedySupportRequestId: linkage.supportRequestId,
      remedyReturnDirective: "return-to-platform",
      shipmentOrderId: linkage.orderId,
      shipmentOrderLineIds: linkage.affectedOrderLineIds,
    }),
    now: () => "2026-09-10T00:00:00.000Z",
  });
}

async function reserveRecordThenInvoke(
  pool: PgTransactionalPool,
  subjectId: string,
  keyDigest: string,
  effect: (operationKey: string) => Promise<void>,
) {
  const reservation = await reservePostageOperation(pool, {
    tenantId: "tnt_fence",
    sellerAccountId: "acc_fence",
    subjectKind: "channel-fulfillment-record",
    subjectId,
    keyDigest,
    requestHash: `request-${keyDigest}`,
    targetKey: `purchase:${subjectId}:initial`,
    operationKind: "purchase-usps-label",
    providerName: "synthetic-postage",
    providerMode: "test",
    request: { subjectKind: "channel-fulfillment-record", subjectId },
  });
  if (!reservation.targetConflict) {
    const claim = await claimReservedPostageOperation(pool, reservation.operation);
    if (!claim) throw new Error("Synthetic record reservation could not be claimed.");
    const invoking = await transitionPostageOperation(pool, {
      claim,
      from: "reserved",
      to: "invoking",
      providerInvoked: true,
    });
    if (!invoking) throw new Error("Synthetic record reservation was lost before invocation.");
    await effect(invoking.operation_key);
  }
  return reservation;
}

describeDb("postage subject production composition fence", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_subject_fence");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ fulfillment: pool });
    await bootstrapContextDatabase(fulfillmentModule, pool);
  });
  afterAll(async () => closeMultiContextTestPools({ fulfillment: pool }));

  it("postage-subject-fence drives actual Shipment, Return Shipment, and reservation-only record effects", async () => {
    const shipmentGate = deferred();
    const shipmentProvider = gatedProvider(pool, shipmentGate);
    const shipmentRuntime = await createPackedShipmentRuntime(pool, "shp_fence", shipmentProvider.provider);
    const firstShipment = purchaseShipment(shipmentRuntime, "shp_fence", "018f47d2-9d2a-4d68-8f33-6fb718c3f101");
    await waitUntil(() => vi.mocked(shipmentProvider.provider.purchaseUspsLabel).mock.calls.length === 1);
    const secondShipment = purchaseShipment(shipmentRuntime, "shp_fence", "018f47d2-9d2a-4d68-8f33-6fb718c3f102").catch(
      (error: unknown) => error,
    );
    await waitUntil(async () => {
      const rows = await pool.query(
        `SELECT operation_key FROM fulfillment_postage_label_operations
         WHERE subject_kind = 'shipment' AND subject_id = 'shp_fence'`,
      );
      return rows.rows.length === 2;
    });
    shipmentGate.resolve();
    const shipmentResults = await Promise.allSettled([firstShipment, secondShipment]);
    expect(shipmentResults[0]?.status).toBe("fulfilled");
    expect(shipmentProvider.provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shipmentProvider.provider.purchaseUspsLabel).mock.calls[0]?.[0]).toMatchObject({
      subjectKind: "shipment",
      subjectId: "shp_fence",
    });
    expect(shipmentProvider.observedReservations).toEqual([
      { subjectKind: "shipment", subjectId: "shp_fence", status: "invoking" },
    ]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM fulfillment_postage_label_operations
           WHERE subject_kind = 'shipment' AND subject_id = 'shp_fence' AND status <> 'failed-safe'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    const returnGate = deferred();
    const returnProvider = gatedProvider(pool, returnGate);
    const returnService = createReturnService(pool, returnProvider.provider);
    const directive = returnDirective("rsh_fence");
    const firstReturn = returnService.issueReturnLabel(directive, context);
    await waitUntil(() => vi.mocked(returnProvider.provider.purchaseUspsLabel).mock.calls.length === 1);
    const secondReturn = await returnService.issueReturnLabel(directive, context);
    expect(secondReturn.outcome).toBe("in-progress");
    returnGate.resolve();
    expect((await firstReturn).outcome).toBe("label-ready");
    expect(returnProvider.provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(returnProvider.provider.purchaseUspsLabel).mock.calls[0]?.[0]).toMatchObject({
      subjectKind: "return-shipment",
      subjectId: "rsh_fence",
    });
    expect(returnProvider.observedReservations).toEqual([
      { subjectKind: "return-shipment", subjectId: "rsh_fence", status: "pending" },
    ]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM fulfillment_return_shipment_label_operations
           WHERE return_shipment_id = 'rsh_fence'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    await pool.query(
      `INSERT INTO fulfillment_channel_fulfillment_record_tenant_resolutions (
         channel_fulfillment_record_id, tenant_id, seller_account_id, status, reason_code, resolved_at
       ) VALUES
         ('cfr_fence', 'tnt_fence', 'acc_fence', 'resolved', 'authoritative-history', now()),
         ('cfr_mutant', 'tnt_fence', 'acc_fence', 'resolved', 'authoritative-history', now())`,
    );
    const recordGate = deferred();
    const recordEffects: string[] = [];
    const recordEffect = vi.fn(async (operationKey: string) => {
      const reservation = await pool.query<{ status: string; subject_kind: string; subject_id: string }>(
        `SELECT status, subject_kind, subject_id
         FROM fulfillment_postage_label_operations WHERE operation_key = $1`,
        [operationKey],
      );
      const row = reservation.rows[0];
      if (
        row?.status !== "invoking" ||
        row.subject_kind !== "channel-fulfillment-record" ||
        row.subject_id !== "cfr_fence"
      ) {
        throw new Error("Synthetic record effect ran before its durable reservation.");
      }
      recordEffects.push(`${row.subject_kind}:${row.subject_id}`);
      await recordGate.promise;
    });
    const firstRecord = reserveRecordThenInvoke(pool, "cfr_fence", "record-left", recordEffect);
    await waitUntil(() => recordEffect.mock.calls.length === 1);
    const secondRecord = reserveRecordThenInvoke(pool, "cfr_fence", "record-right", recordEffect);
    await waitUntil(async () => {
      const rows = await pool.query(
        `SELECT operation_key FROM fulfillment_postage_label_operations
         WHERE subject_kind = 'channel-fulfillment-record' AND subject_id = 'cfr_fence'`,
      );
      return rows.rows.length === 2;
    });
    recordGate.resolve();
    await Promise.all([firstRecord, secondRecord]);
    expect(recordEffect).toHaveBeenCalledTimes(1);
    expect(recordEffects).toEqual(["channel-fulfillment-record:cfr_fence"]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM fulfillment_postage_label_operations
           WHERE subject_kind = 'channel-fulfillment-record' AND subject_id = 'cfr_fence' AND status <> 'failed-safe'`,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);

    const reservationRequiredEffect = async (operationKey: string) => {
      const row = await pool.query(
        `SELECT operation_key FROM fulfillment_postage_label_operations WHERE operation_key = $1`,
        [operationKey],
      );
      if (!row.rows[0]) throw new Error("reservation-before-effect invariant violated");
    };
    await expect(reservationRequiredEffect("bypassed-operation")).rejects.toThrow(
      "reservation-before-effect invariant violated",
    );
    await expect(
      (async () => {
        await reservationRequiredEffect("reordered-operation");
        return reserveRecordThenInvoke(pool, "cfr_mutant", "reordered", reservationRequiredEffect);
      })(),
    ).rejects.toThrow("reservation-before-effect invariant violated");
    await expect(
      reserveRecordThenInvoke(pool, "cfr_mutant", "production-order", reservationRequiredEffect),
    ).resolves.toMatchObject({ targetConflict: false, created: true });

    await pool.query(`DELETE FROM fulfillment_postage_label_operations`);
    await pool.query(`DELETE FROM fulfillment_return_shipment_label_operations`);
    await pool.query(`DROP INDEX fulfillment_postage_label_operations_active_target_v2_idx`);
    try {
      const mutantShipmentGate = deferred();
      const mutantShipmentProvider = gatedProvider(pool, mutantShipmentGate);
      const mutantShipmentRuntime = await createPackedShipmentRuntime(
        pool,
        "shp_fence_removed",
        mutantShipmentProvider.provider,
      );
      const mutantShipmentAttempts = [
        purchaseShipment(mutantShipmentRuntime, "shp_fence_removed", "018f47d2-9d2a-4d68-8f33-6fb718c3f201"),
        purchaseShipment(mutantShipmentRuntime, "shp_fence_removed", "018f47d2-9d2a-4d68-8f33-6fb718c3f202"),
      ];
      await waitUntil(() => vi.mocked(mutantShipmentProvider.provider.purchaseUspsLabel).mock.calls.length === 2);
      mutantShipmentGate.resolve();
      await Promise.allSettled(mutantShipmentAttempts);
      expect(mutantShipmentProvider.provider.purchaseUspsLabel).toHaveBeenCalledTimes(2);

      await pool.query(
        `INSERT INTO fulfillment_channel_fulfillment_record_tenant_resolutions (
           channel_fulfillment_record_id, tenant_id, seller_account_id, status, reason_code, resolved_at
         ) VALUES ('cfr_fence_removed', 'tnt_fence', 'acc_fence', 'resolved', 'authoritative-history', now())`,
      );
      const mutantRecordGate = deferred();
      const mutantRecordEffect = vi.fn(async (operationKey: string) => {
        const reservation = await pool.query(
          `SELECT operation_key FROM fulfillment_postage_label_operations WHERE operation_key = $1`,
          [operationKey],
        );
        if (!reservation.rows[0]) throw new Error("record reservation missing");
        await mutantRecordGate.promise;
      });
      const mutantRecordAttempts = [
        reserveRecordThenInvoke(pool, "cfr_fence_removed", "record-mutant-left", mutantRecordEffect),
        reserveRecordThenInvoke(pool, "cfr_fence_removed", "record-mutant-right", mutantRecordEffect),
      ];
      await waitUntil(() => mutantRecordEffect.mock.calls.length === 2);
      mutantRecordGate.resolve();
      await Promise.all(mutantRecordAttempts);
      expect(mutantRecordEffect).toHaveBeenCalledTimes(2);

      // The actual Return Shipment service is independently fenced by its operation-key ledger. Removing the
      // generalized v2 index therefore cannot produce the two-effect mutant that Shipment and record reservations do.
      const independentReturnGate = deferred();
      const independentReturnProvider = gatedProvider(pool, independentReturnGate);
      const independentReturnService = createReturnService(pool, independentReturnProvider.provider);
      const independentDirective = returnDirective("rsh_fence_removed");
      const firstIndependentReturn = independentReturnService.issueReturnLabel(independentDirective, context);
      await waitUntil(() => vi.mocked(independentReturnProvider.provider.purchaseUspsLabel).mock.calls.length === 1);
      const secondIndependentReturn = await independentReturnService.issueReturnLabel(independentDirective, context);
      independentReturnGate.resolve();
      await firstIndependentReturn;
      expect(secondIndependentReturn.outcome).toBe("in-progress");
      expect(independentReturnProvider.provider.purchaseUspsLabel).toHaveBeenCalledTimes(1);
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM fulfillment_return_shipment_label_operations
             WHERE return_shipment_id = 'rsh_fence_removed'`,
          )
        ).rows,
      ).toEqual([{ count: 1 }]);
    } finally {
      await pool.query(`DELETE FROM fulfillment_postage_label_operations`);
      await pool.query(activeTargetV2IndexSql);
    }
  });
});
