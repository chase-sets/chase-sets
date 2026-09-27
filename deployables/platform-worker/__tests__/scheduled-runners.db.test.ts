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
import { createRegisteredScheduledRunners, type RegisteredScheduledRunnerConfig } from "../src/scheduled-runners";
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
const EXPECTED_REGISTERED_RUNNER_COUNT = 28;
const NEGATIVE_CONTROL_RUNNER_NAME = "negative-control.ambiguous-joined-sql";
const runtimeProfile = "public" as const;
const contextNames = getPlatformWorkerContextsForRuntimeProfile(runtimeProfile);
const syntheticPricingHostPorts = {
  tcgplayerMarketTransport: { kind: "not-mounted" },
  tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies PricingHostPorts;

const scheduledRunnerConfig: RegisteredScheduledRunnerConfig = {
  workerId: "scheduled-runner-db-test",
  leaseTtlMs: 30_000,
  paymentReconciliationIntervalMs: 1,
  paymentDeadlineSweepIntervalMs: 1,
  supportRequestDeadlineSweepIntervalMs: 1,
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

    const postageLabelProvider = createSandboxPostageLabelProvider();
    runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
      pools,
      runtimeProfile,
      hostPorts: {
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
      },
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
            throw event.error;
          },
        },
      }),
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  it("keeps the complete production registration set enumerable", () => {
    const names = registeredRunners.map((runner) => runner.name);

    expect(registeredRunners.length).toBeGreaterThanOrEqual(EXPECTED_REGISTERED_RUNNER_COUNT);
    expect(new Set(names).size).toBe(names.length);
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
      { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
      context,
    );
    const preview = await services.buyerOfferPolicies.execute(
      "bop_worker",
      {
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: 1,
        operationId: "preview",
        terms: {
          currency: "USD",
          adjustmentBps: 0,
          itemCommitmentAllowance: "20.00",
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
