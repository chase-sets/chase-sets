import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import {
  MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE,
  MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES,
  type MarketplaceServices,
} from "@chase-sets/marketplace/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import {
  createEventConsumerAdmission,
  listConsumedEventTypes,
  PLATFORM_WORKER_KIND,
  WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY,
} from "@chase-sets/platform-runtime/worker-event-capability";
import { describe, expect, it, vi } from "vitest";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import { workerContextRegistry } from "../src/context-registry";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const memoryStores = vi.hoisted(() => new WeakMap<object, ReturnType<typeof createInMemoryEventStore>>());
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  return {
    ...actual,
    createPostgresEventStore: (options: Parameters<typeof actual.createPostgresEventStore>[0]) => {
      const memory = memoryStores.get(options.pool)?.eventStore;
      return memory ?? actual.createPostgresEventStore(options);
    },
  };
});

const OFFER_LIFECYCLE_CONSUMERS = [
  "marketplace:marketplace-offer-projection",
  "discovery:discovery-market-projection",
  "discovery:discovery-product-alert-notification-projection",
  "checkout:checkout.sell-list-projection",
  "pricing:pricing-market-input-projection",
] as const;
const lifecycleTypes: readonly string[] = MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES;
const snapshotAt = "2026-10-14T12:00:00.000Z";
const buyerContext = {
  tenantId: "tnt_synthetic_rollout" as never,
  audit: { performedByUserId: "usr_synthetic_rollout" as never, forAccountId: "acc_synthetic_rollout" as never },
};

function unusedPool() {
  const fail = () => {
    throw new Error("The Offer lifecycle rollout test must not touch this database pool.");
  };
  return { query: fail, connect: fail } as never;
}

const secondsAgo = (seconds: number) => new Date(Date.parse(snapshotAt) - seconds * 1000).toISOString();

function heartbeat(
  workerId: string,
  times: Readonly<{ startedSecondsAgo: number; heartbeatSecondsAgo: number }>,
  consumedEventTypes?: readonly string[],
) {
  return {
    worker_id: workerId,
    worker_kind: PLATFORM_WORKER_KIND,
    started_at: secondsAgo(times.startedSecondsAgo),
    heartbeat_at: secondsAgo(times.heartbeatSecondsAgo),
    metadata: consumedEventTypes ? { [WORKER_CONSUMED_EVENT_TYPES_METADATA_KEY]: consumedEventTypes } : {},
  };
}

/** The control-plane rows the admission reads, answered the way its query selects them. */
function createControlPlaneState() {
  const state = {
    quiescedAt: null as string | null,
    workers: [] as ReturnType<typeof heartbeat>[],
    leases: [] as { ownerId: string; expiresAt: string }[],
  };
  const db = {
    query: async () => ({
      rows: [
        {
          snapshot_at: snapshotAt,
          quiesced_at: state.quiescedAt,
          workers: state.workers,
          lease_owner_ids: state.leases
            .filter((lease) => Date.parse(lease.expiresAt) > Date.parse(snapshotAt))
            .map((lease) => lease.ownerId),
        },
      ],
    }),
  } as never;
  return { state, db };
}

describe("Offer lifecycle mixed-version rollout", () => {
  it("appends nothing while an old worker with an expired heartbeat still renews its lease, then reaches all five consumers once a quiesce retires it", async () => {
    const discoverySql: string[] = [];
    const discoveryPool = {
      query: async (sql: string) => {
        discoverySql.push(sql);
        return { rows: [], rowCount: 0 };
      },
      connect: unusedPool,
    } as never;
    const runtime = createWorkerHost(workerContextRegistry, "platform-worker", {
      pools: Object.fromEntries(
        workerContextRegistry.map((entry) => [
          entry.contextName,
          entry.contextName === "discovery" ? discoveryPool : unusedPool(),
        ]),
      ),
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        moneyMovementGateway: createFakeMoneyMovementGateway(),
        operationsRecorder: { record: () => undefined },
        postageLabelProvider: createSandboxPostageLabelProvider(),
        draftListingCreator: { createDraftListings: async () => [] },
        inventoryCleanupAuthority: { kind: "not-mounted" },
        channelSaleRecorder: createPlatformChannelSaleRecorder(unusedPool()),
        notificationAdapter: { send: async () => undefined },
        agentWebhookOrderResolvers: {
          resolveOrderRecipient: async () => null,
          resolveShipmentOrderId: async () => null,
          resolveWebhookTargets: async () => [],
        },
        commercialTermsResolver: createNoopCommercialTermsResolver(),
        channelConnectionIdentityReader: { resolve: async () => null },
      } satisfies PricingHostPorts & Record<string, unknown>,
      runtimeProfile: "public",
    });
    const consumers = OFFER_LIFECYCLE_CONSUMERS.map((key) => {
      const runner = runtime.subscriptionRunners.find(
        (candidate) =>
          candidate.sourceContextName === "marketplace" &&
          `${candidate.targetContextName}:${candidate.projectionName}` === key,
      );
      if (!runner) throw new Error(`Missing Offer lifecycle consumer ${key}.`);
      const newFilter = runner.eventTypes ?? Object.keys(runner.handlers ?? {});
      // The pre-lifecycle build read the same subscription at the same version, without the new events.
      return { key, runner, newFilter, oldFilter: newFilter.filter((type) => !lifecycleTypes.includes(type)) };
    });

    // A capable worker advertises what the production heartbeat advertises; a pre-capability build advertises nothing.
    const capableTypes = listConsumedEventTypes(runtime.subscriptionRunners);
    // The old worker started after the latest quiesce. Its heartbeat writes have failed for 601 seconds, past
    // the old ten-minute window, but it keeps renewing the lease of a consumer it hosts.
    const controlPlane = createControlPlaneState();
    controlPlane.state.quiescedAt = secondsAgo(30 * 60);
    controlPlane.state.workers = [
      heartbeat("wrk_old", { startedSecondsAgo: 25 * 60, heartbeatSecondsAgo: 10 * 60 + 1 }),
      heartbeat("wrk_capable", { startedSecondsAgo: 20 * 60, heartbeatSecondsAgo: 5 }, capableTypes),
    ];
    controlPlane.state.leases = [{ ownerId: "wrk_old", expiresAt: secondsAgo(-20) }];
    const admission = createEventConsumerAdmission({
      // The operator switch is opened early on purpose: worker readiness alone must hold the producer closed.
      open: true,
      db: controlPlane.db,
      requirement: {
        anchorEventType: MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE,
        requiredEventTypes: MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES,
      },
    });
    const store = createInMemoryEventStore();
    const marketplacePool = { query: unusedPool, connect: unusedPool } as unknown as PgTransactionalPool;
    memoryStores.set(marketplacePool, store);
    const marketplace = marketplaceModule.createServices!(marketplacePool, {
      offerLifecycleAdmission: admission,
    } as never) as MarketplaceServices;
    await marketplace.offers.commandHandler({
      streamId: "marketplace.offer-off_synthetic_rollout",
      command: {
        type: "SubmitOffer",
        offerId: "off_synthetic_rollout" as never,
        buyerAccountId: "acc_synthetic_rollout" as never,
        catalogItemId: "cat_synthetic_rollout" as never,
        productId: "cat_synthetic_rollout::" as never,
        itemTitle: "Synthetic rollout card",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        shippingDestinationSnapshot: {
          name: "Synthetic Buyer",
          line1: "1 Synthetic Way",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        priceAmount: "5.00",
        priceCurrencyCode: "USD",
        quantityRequested: 1,
      },
      context: buyerContext,
    });
    const change = (action: "pause" | "resume" | "withdraw") =>
      marketplace.offers.changeOfferLifecycle(
        { offerId: "off_synthetic_rollout" as never, buyerAccountId: "acc_synthetic_rollout" as never, action },
        buyerContext,
      );

    // Phase 1: the old worker is still running, so every producer refuses before any append.
    for (const action of ["pause", "resume", "withdraw"] as const)
      await expect(change(action)).rejects.toMatchObject({
        code: "offer_lifecycle_closed",
        reason: "worker_without_capability",
      });
    expect(await store.eventStore.readAll({ eventTypes: lifecycleTypes })).toEqual([]);
    const sourceHead = (await store.eventStore.readAll()).at(-1)!.globalPosition;
    // Each old consumer reads only the submission through its old filter and checkpoints at the source head.
    const oldTailCheckpoints = new Map<string, typeof sourceHead>();
    for (const consumer of consumers) {
      const read = await store.eventStore.readAll({ eventTypes: consumer.oldFilter });
      expect(
        read.map((event) => event.eventType),
        consumer.key,
      ).toEqual(["marketplace.offer.submitted"]);
      oldTailCheckpoints.set(consumer.key, sourceHead);
    }

    // The next deployment quiesce confirms no worker pod remains, but admission waits for the old lease to drain.
    controlPlane.state.quiescedAt = secondsAgo(60);
    controlPlane.state.workers = [
      heartbeat("wrk_old", { startedSecondsAgo: 25 * 60, heartbeatSecondsAgo: 10 * 60 + 1 }),
      // The quiesce stopped the earlier capable worker too, so it no longer counts as a consumer.
      heartbeat("wrk_capable", { startedSecondsAgo: 20 * 60, heartbeatSecondsAgo: 90 }, capableTypes),
    ];
    await expect(change("pause")).rejects.toMatchObject({
      code: "offer_lifecycle_closed",
      reason: "retired_worker_holds_lease",
    });
    expect(await store.eventStore.readAll({ eventTypes: lifecycleTypes })).toEqual([]);

    // Phase 2: the old lease has expired and a capable worker started since the quiesce is active.
    controlPlane.state.leases = [{ ownerId: "wrk_old", expiresAt: secondsAgo(1) }];
    await expect(change("pause")).rejects.toMatchObject({ reason: "no_capable_worker" });
    controlPlane.state.workers.push(
      heartbeat("wrk_capable_next", { startedSecondsAgo: 30, heartbeatSecondsAgo: 5 }, capableTypes),
    );
    expect(await change("pause")).toMatchObject({ outcome: "changed", status: "paused" });
    expect(await change("resume")).toMatchObject({ outcome: "changed", status: "submitted" });
    expect(await change("withdraw")).toMatchObject({ outcome: "changed", status: "withdrawn" });

    for (const consumer of consumers) {
      const read = await store.eventStore.readAll({
        afterGlobalPosition: oldTailCheckpoints.get(consumer.key)!,
        eventTypes: consumer.newFilter,
      });
      expect(
        read.map((event) => event.eventType),
        consumer.key,
      ).toEqual(lifecycleTypes);
      for (const type of lifecycleTypes) expect(consumer.runner.handlers?.[type], consumer.key).toBeTypeOf("function");
    }

    // The Product Alert consumer applies all three as status updates and never enters the dispatch path.
    const productAlert = consumers.find(
      (consumer) => consumer.key === "discovery:discovery-product-alert-notification-projection",
    )!;
    const lifecycleEvents = (await store.eventStore.readAll({ eventTypes: lifecycleTypes })).map(toTransportEvent);
    for (const event of lifecycleEvents) await productAlert.runner.handlers![event.type]!(event);
    expect(discoverySql).toHaveLength(3);
    for (const sql of discoverySql) expect(sql).toMatch(/^\s*UPDATE discovery_product_alert_market_activity\b/);
  });

  it("closes again when an old worker returns after admission opened", async () => {
    const controlPlane = createControlPlaneState();
    controlPlane.state.quiescedAt = secondsAgo(30 * 60);
    controlPlane.state.workers = [
      heartbeat("wrk_capable", { startedSecondsAgo: 20 * 60, heartbeatSecondsAgo: 5 }, [
        "marketplace.offer.submitted",
        ...lifecycleTypes,
      ]),
    ];
    const admission = createEventConsumerAdmission({
      open: true,
      db: controlPlane.db,
      requirement: {
        anchorEventType: MARKETPLACE_OFFER_LIFECYCLE_ANCHOR_EVENT_TYPE,
        requiredEventTypes: MARKETPLACE_OFFER_LIFECYCLE_EVENT_TYPES,
      },
    });
    await expect(admission.check()).resolves.toEqual({ admitted: true });
    controlPlane.state.workers.push(
      heartbeat("wrk_rolled_back", { startedSecondsAgo: 1, heartbeatSecondsAgo: 1 }, ["marketplace.offer.submitted"]),
    );
    await expect(admission.check()).resolves.toMatchObject({
      admitted: false,
      reason: "worker_without_capability",
      workerIds: ["wrk_rolled_back"],
    });
  });
});
