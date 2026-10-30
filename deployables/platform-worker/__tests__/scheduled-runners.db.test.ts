import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import type { InventoryServices } from "@chase-sets/inventory/server";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { isChannelsServices } from "@chase-sets/channels/server";
import { createBuyerOfferPricing, type PricingHostPorts } from "@chase-sets/pricing/server";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  type PlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import { collectRetentionSweepTargets } from "@chase-sets/platform-runtime/retention-sweep";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import { createWorkerHost, type WorkerHostRuntime, type WorkerRunner } from "@chase-sets/platform-runtime/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPlatformWorkerContextsForRuntimeProfile } from "../src/config";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createInventoryProductResolutionMaintenanceRunners,
  createRegisteredScheduledRunners,
  createSupportEvidenceCleanupHostPort,
  type RegisteredScheduledRunnerConfig,
} from "../src/scheduled-runners";
import {
  attachmentOperationStreamId,
  createAttachmentManifest,
  parseSupportEvidenceCleanupBinding,
  type PlatformOperationsServices,
} from "@chase-sets/platform-operations/server";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createChannelsOutboundRunners } from "../src/channels-outbound-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for platform-worker scheduled-runner DB tests in CI.");
}

const describeDatabase = adminDatabaseUrl ? describe : describe.skip;
// 34 factory sites, minus the legacy postage-purchase fallback, plus cleanup and retention.
const EXPECTED_REGISTERED_RUNNER_COUNT = 34;
const NEGATIVE_CONTROL_RUNNER_NAME = "negative-control.ambiguous-joined-sql";
const runtimeProfile = "public" as const;
const contextNames = getPlatformWorkerContextsForRuntimeProfile(runtimeProfile);
const syntheticPricingHostPorts = {
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies PricingHostPorts;

const scheduledRunnerConfig: RegisteredScheduledRunnerConfig = {
  workerId: "scheduled-runner-db-test",
  leaseTtlMs: 30_000,
  paymentReconciliationIntervalMs: 1,
  paymentDeadlineSweepIntervalMs: 1,
  channelsConnectorLivenessSweepIntervalMs: 1,
  supportRequestDeadlineSweepIntervalMs: 1,
  supportEvidenceCleanupIntervalMs: 1,
  customerFeedbackAttentionDigestIntervalMs: 1,
  customerFeedbackAttentionTeamRecipientUserIds: [],
  reviewWindowSweepIntervalMs: 1,
  reviewOpportunityReminderSweepIntervalMs: 1,
  sellerAvailabilityRestoreSweepIntervalMs: 1,
  sellerAwayWindowStartSweepIntervalMs: 1,
  sellerFundsReleaseIntervalMs: 1,
  spendHoldSweepIntervalMs: 1,
  payoutReconciliationIntervalMs: 1,
  liabilityReconciliationIntervalMs: 1,
  marketRollupsCloserIntervalMs: 1,
  settlementAccountLinkageCloserIntervalMs: 1,
  gmvReconciliationIntervalMs: 1,
  catalogProviderScopeRefreshIntervalMs: 1,
  googleMerchant: {
    syncEnabled: true,
    dryRun: true,
    merchantAccountId: "scheduled-runner-db-test",
    apiDataSourceId: "scheduled-runner-db-test",
    targetCountry: "US",
    contentLanguage: "en",
    feedLabel: "US",
    credentialSecretName: "scheduled-runner-db-test",
    productionSyncApprovalReference: null,
  },
  googleShoppingMaintenanceIntervalMs: 1,
  googleShoppingMaintenanceBatchSize: 1,
  googleShoppingRefreshWindowDays: 1,
  googleShoppingDiagnosticsIntervalMs: 1,
  googleShoppingDiagnosticsBatchSize: 1,
  discoverySearchEmbeddings: {
    apiKey: "scheduled-runner-db-test",
    model: "scheduled-runner-db-test",
    batchSize: 1,
    timeoutMs: 1_000,
    maxAttempts: 1,
    retryBackoffBaseMs: 1,
    retryBackoffMaxMs: 1,
    intervalMs: 1,
    rolloutValue: "true",
    rescueValue: "false",
    hybridValue: "false",
    queryCacheMaxEntries: 1,
    queryCacheTtlMs: 1_000,
    queryTimeoutMs: 800,
  },
};

describeDatabase("registered platform-worker scheduled runners", () => {
  let pools: Readonly<Record<string, PgTransactionalPool>>;
  let runtime: WorkerHostRuntime;
  let controlPlane: PlatformControlPlane;
  let registeredRunners: readonly WorkerRunner[];
  const externalFetch = vi.fn(async () => {
    throw new Error("Scheduled-runner DB tests must not call a live external provider.");
  });

  beforeAll(async () => {
    vi.stubGlobal("fetch", externalFetch);
    const databaseUrls = createMultiContextTestDatabaseUrls(
      adminDatabaseUrl!,
      [...contextNames, "control"],
      "platform_worker_scheduled_runners",
    );
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    await bootstrapPlatformControlPlane(pools.control);
    controlPlane = createPostgresPlatformControlPlane(pools.control);

    runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
      pools,
      runtimeProfile,
      hostPorts: workerHostPorts(),
    });

    for (const context of runtime.mountedContexts) {
      await bootstrapContextDatabase(context.module, context.pool);
    }

    registeredRunners = createRegisteredScheduledRunners({
      services: runtime.services,
      config: scheduledRunnerConfig,
      controlPlane,
      logger: {
        info: () => undefined,
        warn: () => undefined,
      },
      workSignalCleanup: () => ({
        workSignalStore: createPostgresWorkSignalStore(pools.control),
        intervalMs: 1,
      }),
      retentionSweep: () => ({
        targets: collectRetentionSweepTargets(runtime, pools.control),
        observer: {
          sweepFailed: (event) => {
            throw new Error(
              `Retention sweep ${event.contextName}.${event.sweepName} failed: ${event.failure.errorClass} ${event.failure.errorCode ?? "no-code"}`,
            );
          },
        },
      }),
    });
  });

  function workerHostPorts(overrides: Readonly<Record<string, unknown>> = {}) {
    const postageLabelProvider = createSandboxPostageLabelProvider();
    return {
      capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider,
      addressVerificationProvider: postageLabelProvider,
      ...syntheticPricingHostPorts,
      managedOfferPricing: createBuyerOfferPricing(pools.pricing),
      // Real-registry composition: the worker states the Ordering
      // cleanup-authority capability explicitly as not-mounted (#7222).
      inventoryCleanupAuthority: { kind: "not-mounted" },
      channelSaleRecorder: createPlatformChannelSaleRecorder(pools.inventory),
      searchEmbeddingConfig: scheduledRunnerConfig.discoverySearchEmbeddings,
      ...overrides,
    };
  }
  function registeredRunnersOf(host: WorkerHostRuntime) {
    return createRegisteredScheduledRunners({
      services: host.services,
      config: scheduledRunnerConfig,
      controlPlane,
      logger: { info: () => undefined, warn: () => undefined },
      workSignalCleanup: () => ({ workSignalStore: createPostgresWorkSignalStore(pools.control), intervalMs: 1 }),
      retentionSweep: () => ({ targets: collectRetentionSweepTargets(host, pools.control) }),
    });
  }

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("keeps the complete production registration set enumerable", () => {
    const names = registeredRunners.map((runner) => runner.name);

    expect(registeredRunners.length).toBe(EXPECTED_REGISTERED_RUNNER_COUNT);
    expect(names.filter((name) => name === "channels.connector-liveness-sweep")).toHaveLength(1);
    expect(names.filter((name) => name === "channels.ebay-account-deletion-receipt-expiry")).toHaveLength(1);
    expect(names).not.toContain("pricing.tcgplayer-market-capture");
    expect(new Set(names).size).toBe(names.length);
  });

  it("drains 1001 expired eBay receipts through the actual registered runner; omission leaves all expired rows", async () => {
    await pools.channels.query(`INSERT INTO channels_ebay_account_deletion_receipts
      (notification_id,topic,event_date,publish_date,publish_attempt_count,subject_key_id,subject_fingerprint,
       subject_iv,subject_ciphertext,subject_tag,received_at,expires_at)
      SELECT 'synthetic-expiry-' || n, 'MARKETPLACE_ACCOUNT_DELETION',statement_timestamp(),statement_timestamp(),1,
        'synthetic-seal','v1:ebay-subject-root-v1:' || repeat('a',64),decode(repeat('00',12),'hex'),
        decode('00','hex'),decode(repeat('00',16),'hex'),statement_timestamp()-interval '31 days',
        CASE WHEN n=1002 THEN statement_timestamp()+interval '1 day' ELSE statement_timestamp()-interval '1 day' END
      FROM generate_series(1,1002) n`);
    const selected = registeredRunners.filter(
      (runner) => runner.name === "channels.ebay-account-deletion-receipt-expiry",
    );
    const expiredCount = async () =>
      (
        await pools.channels.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM channels_ebay_account_deletion_receipts WHERE expires_at <= statement_timestamp()",
        )
      ).rows[0]!.count;
    await runRegisteredRunnerSetOnce(selected.filter(() => false));
    expect(await expiredCount()).toBe(1001);
    expect(selected).toHaveLength(1);
    const started = performance.now();
    let processed = 0;
    let result;
    do {
      result = await selected[0]!.runOnce();
      processed += result.processed;
    } while (selected[0]!.rescheduleOnCompletion?.(result));
    const elapsedMs = performance.now() - started;
    expect(processed).toBe(1001);
    console.info(
      JSON.stringify({
        type: "synthetic-ebay-expiry-operating-envelope",
        rows: 1001,
        elapsedMs,
        budgetMs: 1800000,
        maxRowsPerDelete: 500,
      }),
    );
    expect(await expiredCount()).toBe(0);
    expect(
      (await pools.channels.query("SELECT notification_id FROM channels_ebay_account_deletion_receipts")).rows,
    ).toEqual([{ notification_id: "synthetic-expiry-1002" }]);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("executes the exact Channels outbound runner set with real composed services", async () => {
    expect(isChannelsServices(runtime.services.channels)).toBe(true);
    const runners = createChannelsOutboundRunners(runtime.services, {
      workerId: "channels-composition-db-test",
      channelsOutboundOperationLaneCount: 2,
    });
    expect(runners.map((runner) => runner.name)).toEqual([
      "job:channels.outbound-operations.lane-1",
      "job:channels.outbound-operations.lane-2",
    ]);
    for (const runner of runners) {
      await expect(runner.runOnce()).resolves.toEqual({ processed: 0, lastGlobalPosition: "0" });
    }
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("executes every registered runner once against its bootstrapped context database", async () => {
    await runRegisteredRunnerSetOnce(registeredRunners);

    const result = await pools.control.query<{ runner_name: string; last_completed_at: Date | null }>(
      `SELECT runner_name, last_completed_at
       FROM platform_scheduled_runners
       WHERE runner_name = ANY($1::text[])
       ORDER BY runner_name`,
      [registeredRunners.map((runner) => runner.name)],
    );

    expect(result.rows.map((row) => row.runner_name)).toEqual(registeredRunners.map((runner) => runner.name).sort());
    expect(result.rows.every((row) => row.last_completed_at !== null)).toBe(true);
    expect(result.rows.some((row) => row.runner_name === "durable-jobs.retention")).toBe(true);
    expect(
      result.rows.some((row) => row.runner_name === "inventory.import-product-resolution-maintenance.enqueue"),
    ).toBe(true);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("runs the live Import Product worker to its durable receipt and refuses a missing service source", async () => {
    expect(createInventoryProductResolutionMaintenanceRunners({}, scheduledRunnerConfig)).toEqual([]);
    const services = runtime.services.inventory as InventoryServices;
    await services.importBatches.enqueueProductResolutionMaintenanceJob();
    const runners = createInventoryProductResolutionMaintenanceRunners(runtime.services, scheduledRunnerConfig);
    expect(runners).toHaveLength(1);
    expect((await runners[0]!.runOnce()).processed).toBe(1);
    const job = await services.importBatches.getImportBatchJob("inventory-import-product-resolution-maintenance");
    expect(job?.status).toBe("completed");
    expect(job?.result?.maintenanceReceipt).toMatchObject({
      complete: true,
      unitId: "normalize-legacy-rejected-products-v1",
    });
    expect((await runners[0]!.runOnce()).processed).toBe(0);
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("runs a published Market Price through the registered reaction, durable job, real Pricing evaluator and managed Offer command", async () => {
    const services = runtime.services.marketplace as MarketplaceServices;
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const context = {
      tenantId: "tnt_identity" as never,
      audit: { performedByUserId: "usr_managed" as never, forAccountId: "acc_managed" as never },
    };
    const offerId = "off_managed_worker";
    await services.offers.commandHandler({
      streamId: `marketplace.offer-${offerId}`,
      context,
      command: {
        type: "SubmitOffer",
        offerId: offerId as never,
        buyerAccountId: "acc_managed" as never,
        catalogItemId: "cat_managed_worker" as never,
        productId: "cat_managed_worker::" as never,
        itemTitle: "Managed fixture",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: {
          name: "Buyer",
          line1: "1 Main",
          line2: null,
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
    });
    await services.buyerOfferPolicies.execute(
      "bop_worker",
      {
        type: "CreateBuyerOfferPolicy",
        expectedVersion: 0,
        operationId: "create",
        attemptId: "worker_policy_create_attempt",
      },
      context,
    );
    const preview = await services.buyerOfferPolicies.execute(
      "bop_worker",
      {
        type: "PreviewBuyerOfferPolicy",
        attemptId: "worker_policy_preview_attempt",
        expectedVersion: 1,
        operationId: "preview",
        terms: {
          currency: "USD",
          adjustmentBps: 0,
          offers: [
            {
              offerId,
              offerVersion: 1,
              catalogItemId: "cat_managed_worker",
              productId: "cat_managed_worker::",
              selectedOptions: [],
              quantity: 1,
              maximumUnitItemAmount: "15.00",
            },
          ],
        },
      },
      context,
    );
    await services.buyerOfferPolicies.execute(
      "bop_worker",
      {
        type: "AuthorizeBuyerOfferPolicy",
        attemptId: "worker_policy_authorize_attempt",
        expectedVersion: 2,
        operationId: "authorize",
        previewId: preview.preview!.previewId,
        consent: true,
      },
      context,
    );
    async function project() {
      for (const event of await store.readAll())
        for (const set of services.projectors)
          if (set.handlers[event.eventType]) await set.handlers[event.eventType]!(toTransportEvent(event));
    }
    await project();
    await pools.pricing
      .query(`INSERT INTO pricing_market_price_estimates (catalog_catalog_item_id, product_id, estimate_version,
      window_started_at, window_ended_at, amount, currency_code, confidence, estimated_at, fresh_until, disclosure, updated_at)
      VALUES ('cat_managed_worker','cat_managed_worker::',7,now()-interval '1 day',now(),'12.00','USD','high',now(),now()+interval '1 hour','public',now())`);
    const job = registeredRunners.find((runner) => runner.name === "marketplace.managed-offer-work")!;
    await pools.control.query(
      "DELETE FROM platform_scheduled_runners WHERE runner_name = 'marketplace.managed-offer-work'",
    );
    await job.runOnce();
    expect(await store.readStream({ streamId: `marketplace.offer-${offerId}` })).toHaveLength(2);
    const backlogId = await services.managedOfferWork.enqueue(
      { catalogItemId: "cat_recovery_backlog", productId: "cat_recovery_backlog::" },
      "synthetic_recovery_backlog",
      context,
      "recovery",
    );
    const reaction = marketplaceModule.buildSubscriptions!(services).find(
      (s) => s.reactionName === "marketplace-managed-offer-reaction",
    )!;
    await reaction.handlers["pricing.market-price.estimated"]!(
      buildTransportEvent("pricing.market-price.estimated", {
        catalogItemId: "cat_managed_worker",
        productId: "cat_managed_worker::",
        estimateVersion: "7",
      }),
    );
    await project();
    await pools.control.query(
      "DELETE FROM platform_scheduled_runners WHERE runner_name = 'marketplace.managed-offer-work'",
    );
    await job.runOnce();
    const events = await store.readStream({ streamId: `marketplace.offer-${offerId}` });
    expect(events.at(-2)).toMatchObject({
      eventType: "marketplace.offer.price-updated",
      payload: { priceAmount: "12.00" },
    });
    expect(events.at(-1)).toMatchObject({
      eventType: "marketplace.offer.managed-evaluated",
      payload: {
        evidence: {
          marketPrice: { estimateVersion: "7" },
          policyRevision: 1,
          maximumUnitItemAmount: "15.00",
        },
      },
    });
    expect((await store.readStream({ streamId: `marketplace.offer-work-${backlogId}` })).at(-1)!.payload.status).toBe(
      "pending",
    );
    await project();
    await services.managedOfferWork.run(context);
    await project();

    // The registered recovery runner must stop at its durable completion barrier,
    // then finish new generations without rewriting an unchanged held Offer.
    await pools.pricing.query(
      "UPDATE pricing_market_price_estimates SET fresh_until = now() - interval '1 hour' WHERE catalog_catalog_item_id = 'cat_managed_worker'",
    );
    const recovery = registeredRunners.find((runner) => runner.name === "marketplace.managed-offer-recovery")!;
    async function runRegistered(runner: WorkerRunner) {
      await pools.control.query("DELETE FROM platform_scheduled_runners WHERE runner_name = $1", [runner.name]);
      await runner.runOnce();
    }
    const initialCursor = await pools.marketplace.query<{ generation: string }>(
      "SELECT generation::text FROM marketplace_managed_offer_recovery",
    );
    const initialGeneration = BigInt(initialCursor.rows[0].generation);
    let firstHold: Awaited<ReturnType<typeof store.readStream>> | undefined;
    for (let generation = 0; generation < 4; generation++) {
      await runRegistered(recovery);
      const requested = (await store.readAll()).filter(
        (event) => event.eventType === "marketplace.offer.work-requested",
      );
      await runRegistered(recovery); // Deliberately before projection catches up.
      expect((await store.readAll()).filter((event) => event.eventType === "marketplace.offer.work-requested")).toEqual(
        requested,
      );
      await project();
      await runRegistered(job);
      await project();
      await runRegistered(recovery);
      const heldEvents = await store.readStream({ streamId: `marketplace.offer-${offerId}` });
      firstHold ??= heldEvents;
      expect(heldEvents).toEqual(firstHold);
      expect(heldEvents).toHaveLength(events.length + 1);
      expect(heldEvents.at(-1)!.payload.status).toBe("held");
      const cursor = await pools.marketplace.query(
        "SELECT generation::text, pending_work_ids FROM marketplace_managed_offer_recovery",
      );
      expect(cursor.rows).toEqual([
        { generation: String(initialGeneration + BigInt(generation + 1)), pending_work_ids: [] },
      ]);
    }
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("cleans a Support evidence operation only through the actual worker composition of a valid binding (AC-E2, AC-E4)", async () => {
    const store = createPostgresEventStore({ pool: pools["platform-operations"] });
    const context = {
      tenantId: "tnt_identity" as never,
      audit: { performedByUserId: "usr_worker_owner" as never, forAccountId: "acc_worker_owner" as never },
    };
    const owner = {
      tenantId: "tnt_identity",
      accountId: "acc_worker_owner",
      supportRequestId: "sup_worker_cleanup",
      operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    const fingerprint = {
      profile: "support-evidence-raster/v1",
      sharp: "t",
      libvips: "t",
      platform: "t",
      arch: "t",
      libc: "t",
    };
    const manifest = createAttachmentManifest({
      owner,
      profile: fingerprint.profile,
      encoderFingerprint: fingerprint,
      images: [{ canonicalSha256: "d".repeat(64), contentType: "image/png", byteSize: 4 }],
    });
    const streamId = attachmentOperationStreamId(owner);
    await store.appendToStream({
      streamId: `support.support-request-${owner.supportRequestId}`,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "support.support-request.test-barrier", payload: {} }],
    });
    await store.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "support.attachment-operation.staged", payload: manifest },
        { eventType: "support.attachment-operation.stored", payload: { index: 0 } },
        { eventType: "support.attachment-operation.cleanup-required", payload: { reason: "put-failed" } },
      ],
    });
    const key = `support-evidence/${owner.supportRequestId}/${manifest.items[0]!.attachmentId}/${"d".repeat(64)}.png`;
    const objects = new Set([key]);
    const privateStore = {
      putPrivate: vi.fn(),
      readPrivate: vi.fn(),
      listPrivate: vi.fn(),
      deleteKeys: vi.fn(async (keys: readonly string[]) =>
        keys.map((k) => ({ key: k, status: objects.delete(k) ? ("deleted" as const) : ("absent" as const) })),
      ),
      verifyPrivate: vi.fn(async (k: string) =>
        objects.has(k) ? { status: "match" as const } : { status: "absent" as const },
      ),
    };
    const instance = JSON.stringify(["support-deployment-instance/v1", "test", "release-a"]);
    const compose = (revision: number) =>
      createWorkerHost(workerContextRegistry, "platform-worker", {
        pools,
        runtimeProfile,
        hostPorts: workerHostPorts(
          createSupportEvidenceCleanupHostPort(
            {
              deploymentEnvironment: "test",
              supportEvidenceCleanupBinding: parseSupportEvidenceCleanupBinding(
                JSON.stringify({
                  version: 1,
                  environment: "test",
                  deploymentInstance: instance,
                  bindingId: "cleanup-worker",
                  revision,
                  active: true,
                }),
                { environment: "test", deploymentInstance: instance, implementationSha: "b".repeat(40) },
              ),
              supportEvidenceStorage: {
                kind: "s3",
                bucket: "unused",
                region: "unused",
                publicBaseUrl: "https://unused.invalid",
              },
            },
            { info: () => undefined },
            () => privateStore,
          ),
        ),
      });
    const cleanupOf = (host: WorkerHostRuntime) =>
      (host.services["platform-operations"] as PlatformOperationsServices).supportRequests.attachmentCleanup;
    const cleanupRunner = (host: WorkerHostRuntime) => {
      const runners = registeredRunnersOf(host);
      expect(runners).toHaveLength(EXPECTED_REGISTERED_RUNNER_COUNT + 1);
      return runners.find((runner) => runner.name === "support-evidence-operation-cleanup")!;
    };
    const host = compose(1);
    const locator = (host.services["platform-operations"] as PlatformOperationsServices).projectors.find(
      (set) => set.projectionName === "support-evidence-cleanup-locator-projection",
    )!;
    for (const event of await readCompleteStream(store, { streamId }))
      await locator.handlers[event.eventType]!(toTransportEvent(event));

    expect(await cleanupRunner(host).runOnce()).toMatchObject({ processed: 1 });
    expect(privateStore.deleteKeys).toHaveBeenCalledTimes(1);
    expect(privateStore.deleteKeys).toHaveBeenCalledWith([key]);
    expect(objects.size).toBe(0);
    const types = (await readCompleteStream(store, { streamId })).map((event) => event.eventType.split(".").at(-1));
    expect(types).toEqual(["staged", "stored", "cleanup-required", "cleanup-claimed", "deleted-unreferenced"]);
    const attempts = await readCompleteStream(store, { streamId: `support.evidence-access-${owner.supportRequestId}` });
    expect(attempts.map((event) => event.payload.serviceBinding)).toEqual([
      { bindingId: "cleanup-worker", revision: 1 },
    ]);

    // Restart and the day after: nothing resurrects and no further provider work happens.
    expect(await cleanupRunner(compose(1)).runOnce()).toMatchObject({ processed: 0 });
    // A newer binding revision makes the older process stale; it denies before any provider work.
    const newer = cleanupOf(compose(2));
    if (newer.kind !== "available") throw new Error("revision 2 must mount cleanup");
    await newer.initialize();
    const stale = cleanupOf(host);
    if (stale.kind !== "available") throw new Error("revision 1 must mount cleanup");
    expect(await stale.run()).toMatchObject({ denied: "binding_receipt_stale", examined: 0 });
    expect(privateStore.deleteKeys).toHaveBeenCalledTimes(1);
    for (const method of [privateStore.putPrivate, privateStore.readPrivate, privateStore.listPrivate])
      expect(method).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("names a runner whose joined SQL has an actually ambiguous column", async () => {
    expect.assertions(3);
    const negativeControl: WorkerRunner = {
      name: NEGATIVE_CONTROL_RUNNER_NAME,
      kind: "job",
      runOnce: async () => {
        await pools.control.query(
          `SELECT priority
           FROM (VALUES (1, 10)) AS first_queue(id, priority)
           JOIN (VALUES (1, 20)) AS second_queue(id, priority) USING (id)`,
        );
        return { processed: 0, lastGlobalPosition: "0" as never };
      },
    };

    try {
      await runRegisteredRunnerSetOnce([negativeControl, ...registeredRunners]);
      expect.fail("The deliberately ambiguous joined SQL unexpectedly succeeded.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(NEGATIVE_CONTROL_RUNNER_NAME);
      expect((error as Error & { cause?: { code?: string } }).cause?.code).toBe("42702");
    }
  });
});

async function runRegisteredRunnerSetOnce(runners: readonly WorkerRunner[]) {
  for (const runner of runners) {
    try {
      await runner.runOnce();
    } catch (error) {
      throw new Error(`Scheduled runner '${runner.name}' failed.`, { cause: error });
    }
  }
}
