import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import { createHash } from "node:crypto";
import {
  buildProjectionInterestIndex,
  lookupProjectionInterests,
} from "@chase-sets/platform-runtime/projection-interest-index";
import { listProjectionInterestOverridesForPushMigration } from "@chase-sets/platform-runtime/projection-push-migration";
import {
  fanOutEventStoreWakeNotification,
  type ProjectionWakeRelayWorkSignalStore,
} from "@chase-sets/platform-runtime/projection-wake-relay";
import { listSourceContextWakeRelayConfigs } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { describe, expect, it } from "vitest";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const syntheticPricingHostPorts = {
  tcgplayerMarketTransport: { kind: "not-mounted" },
  tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies PricingHostPorts;

const OPERATOR_REMOVAL = "marketplace.listing.operator-unlisted";
const REMOVAL_CONSUMERS = [
  ["marketplace", "marketplace-listing-projection", 2],
  ["platform-operations", "reported-content-queue-projection", 1],
  ["discovery", "discovery-market-projection", 3],
  ["discovery", "discovery-product-alert-notification-projection", 2],
] as const;
const OFFER_LIFECYCLE_EVENTS = [
  "marketplace.offer.paused",
  "marketplace.offer.resumed",
  "marketplace.offer.withdrawn",
] as const;
const OFFER_LIFECYCLE_CONSUMERS = [
  ["marketplace", "marketplace-offer-projection", 1],
  ["discovery", "discovery-market-projection", 3],
  ["discovery", "discovery-product-alert-notification-projection", 2],
  ["checkout", "checkout.sell-list-projection", 3],
  ["pricing", "pricing-market-input-projection", 2],
] as const;

const ORDERING_CREATED_INVENTORY_RESERVATION_TARGET = {
  sourceContextName: "ordering",
  eventType: "ordering.order.created",
  targetContextName: "inventory",
  projectionName: "inventory-order-reservation-workflow",
  checkpointKey: "inventory-order-reservation-workflow:ordering:v1",
} as const;

const INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET = {
  sourceContextName: "inventory",
  eventType: "inventory.channel-stock-allocation.set",
  targetContextName: "inventory",
  projectionName: "inventory-channel-stock-allocation-projection",
  checkpointKey: "inventory-channel-stock-allocation-projection:inventory:v1",
} as const;

const AGENT_WEBHOOK_TARGETS = [
  {
    sourceContextName: "ordering",
    eventType: "ordering.order.created",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:ordering:v1",
  },
  {
    sourceContextName: "fulfillment",
    eventType: "fulfillment.shipment.dispatched",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:fulfillment:v1",
  },
  {
    sourceContextName: "payments",
    eventType: "payments.refund-issued",
    targetContextName: "auth",
    projectionName: "auth-agent-order-webhook-projection",
    checkpointKey: "auth-agent-order-webhook-projection:payments:v1",
  },
] as const;

const NOTIFICATIONS_FULFILLMENT_TARGET = {
  sourceContextName: "fulfillment",
  targetContextName: "notifications",
  projectionName: "notifications-source-facts-outbox-projection",
  checkpointKey: "notifications-source-facts-outbox-projection:fulfillment:v2",
  eventTypes: ["fulfillment.shipment.dispatched", "fulfillment.shipment.delivered"],
} as const;

describe("platform worker projection wake interest graph", () => {
  it("composes forward-only listing directive delivery independently of review checkpoints and removal consumers", () => {
    const runtime = createPlatformWorkerHost();
    const eventType = "platform-operations.reported-content.listing-removal-directed";
    const name = "marketplace-listing-moderation-reaction";
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    expect(
      lookupProjectionInterests(index, { sourceContextName: "platform-operations", eventType }).map(
        ({ targetContextName, projectionName }) => `${targetContextName}:${projectionName}`,
      ),
    ).toEqual([`marketplace:${name}`]);
    const runner = runtime.subscriptionRunners.find(({ projectionName }) => projectionName === name);
    expect(runner).toMatchObject({
      checkpointKey: `${name}:platform-operations:v1`,
      subscriptionVersion: 1,
      handlerKind: "reaction",
      eventTypes: [eventType],
    });
    expect(runner?.handlers?.[eventType]).toBeTypeOf("function");
    expect(
      runtime.subscriptionRunners.find(
        ({ projectionName }) => projectionName === "marketplace-review-moderation-reaction",
      ),
    ).toMatchObject({
      checkpointKey: "marketplace-review-moderation-reaction:platform-operations:v1",
      subscriptionVersion: 1,
      eventTypes: ["platform-operations.reported-content.action-recorded"],
    });
    const disabled = buildPlatformWorkerProjectionWakeRelayInterestIndex([`marketplace:${name}`]);
    expect(lookupProjectionInterests(disabled, { sourceContextName: "platform-operations", eventType })).toEqual([]);
    expect(
      lookupProjectionInterests(disabled, { sourceContextName: "marketplace", eventType: OPERATOR_REMOVAL }),
    ).toEqual(lookupProjectionInterests(index, { sourceContextName: "marketplace", eventType: OPERATOR_REMOVAL }));
  });

  it("resolves operator removal to every existing visibility consumer independently", () => {
    const runtime = createPlatformWorkerHost();
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    const interests = lookupProjectionInterests(index, {
      sourceContextName: "marketplace",
      eventType: OPERATOR_REMOVAL,
    });
    expect(interests.map((entry) => `${entry.targetContextName}:${entry.projectionName}`).sort()).toEqual(
      REMOVAL_CONSUMERS.map(([owner, name]) => `${owner}:${name}`).sort(),
    );
    for (const [targetContextName, projectionName, subscriptionVersion] of REMOVAL_CONSUMERS) {
      const runners = runtime.subscriptionRunners.filter(
        (runner) =>
          runner.sourceContextName === "marketplace" &&
          runner.targetContextName === targetContextName &&
          runner.projectionName === projectionName,
      );
      expect(runners).toHaveLength(1);
      expect(runners[0]).toMatchObject({
        subscriptionVersion,
        checkpointKey: `${projectionName}:marketplace:v${subscriptionVersion}`,
      });
      expect(runners[0]?.eventTypes).toContain(OPERATOR_REMOVAL);
      expect(runners[0]?.handlers?.[OPERATOR_REMOVAL]).toBeTypeOf("function");
      const disabled = buildPlatformWorkerProjectionWakeRelayInterestIndex([`${targetContextName}:${projectionName}`]);
      const remaining = lookupProjectionInterests(disabled, {
        sourceContextName: "marketplace",
        eventType: OPERATOR_REMOVAL,
      });
      expect(remaining.map((entry) => `${entry.targetContextName}:${entry.projectionName}`).sort()).toEqual(
        REMOVAL_CONSUMERS.filter(([owner, name]) => owner !== targetContextName || name !== projectionName)
          .map(([owner, name]) => `${owner}:${name}`)
          .sort(),
      );
    }
    expect(
      lookupProjectionInterests(index, { sourceContextName: "platform-operations", eventType: OPERATOR_REMOVAL }),
    ).toEqual([]);
  });

  it("resolves each Offer lifecycle event to every open-Offer consumer", () => {
    const runtime = createPlatformWorkerHost();
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    for (const eventType of OFFER_LIFECYCLE_EVENTS) {
      const interests = lookupProjectionInterests(index, { sourceContextName: "marketplace", eventType });
      expect(interests.map((entry) => `${entry.targetContextName}:${entry.projectionName}`).sort()).toEqual(
        OFFER_LIFECYCLE_CONSUMERS.map(([owner, name]) => `${owner}:${name}`).sort(),
      );
    }
    for (const [targetContextName, projectionName, subscriptionVersion] of OFFER_LIFECYCLE_CONSUMERS) {
      const runners = runtime.subscriptionRunners.filter(
        (runner) =>
          runner.sourceContextName === "marketplace" &&
          runner.targetContextName === targetContextName &&
          runner.projectionName === projectionName,
      );
      expect(runners).toHaveLength(1);
      expect(runners[0]).toMatchObject({
        subscriptionVersion,
        checkpointKey: `${projectionName}:marketplace:v${subscriptionVersion}`,
      });
      for (const eventType of OFFER_LIFECYCLE_EVENTS) {
        expect(runners[0]?.eventTypes).toContain(eventType);
        expect(runners[0]?.handlers?.[eventType]).toBeTypeOf("function");
      }
    }
  });

  it("boots every public-profile context and creates the Checkout Session runner from its local projector", () => {
    const runtime = createPlatformWorkerHost("public");
    const mountedContextNames = runtime.mountedContexts.map((entry) => entry.contextName).sort();
    const registryContextNames = workerContextRegistry.map((entry) => entry.contextName).sort();
    const checkoutModule = runtime.mountedContexts.find((entry) => entry.contextName === "checkout")?.module;
    const checkoutSessionRunner = runtime.subscriptionRunners.find(
      (runner) =>
        runner.targetContextName === "checkout" &&
        runner.sourceContextName === "checkout" &&
        runner.projectionName === "checkout.session-projection",
    );

    expect(mountedContextNames).toEqual(registryContextNames);
    expect(runtime.mountedContexts.every((entry) => entry.mountRole === "active")).toBe(true);
    expect(
      checkoutModule?.eventSubscriptions?.find(
        (subscription) =>
          subscription.sourceContextName === "checkout" &&
          subscription.projectionName === "checkout.session-projection",
      ),
    ).toBeUndefined();
    expect(checkoutSessionRunner).toMatchObject({
      checkpointKey: "checkout.session-projection:checkout:v1",
      subscriptionVersion: 1,
    });
    expect(checkoutSessionRunner?.eventTypes).toEqual([
      "checkout.session.authenticity-check-opt-in-selected",
      "checkout.session.cancelled",
      "checkout.session.fulfillment-preview-recorded",
      "checkout.session.offer-submitted",
      "checkout.session.optimization-goal-selected",
      "checkout.session.orders-created",
      "checkout.session.payment-started",
      "checkout.session.reservations-recorded",
      "checkout.session.shipping-address-set",
      "checkout.session.shipping-option-selected",
      "checkout.session.started",
    ]);
  });

  it("resolved-subscription base parity", () => {
    const runtime = createPlatformWorkerHost("public");
    const allRawSubscriptions = runtime.mountedContexts.flatMap((entry) =>
      (entry.module.buildSubscriptions?.(entry.services) ?? []).map((subscription) => ({
        targetContextName: entry.contextName,
        subscription,
      })),
    );
    const added = allRawSubscriptions.filter(
      ({ targetContextName, subscription }) =>
        targetContextName === "marketplace" &&
        subscription.projectionName === "marketplace-listing-moderation-reaction",
    );
    expect(added).toHaveLength(1);
    const rawSubscriptions = allRawSubscriptions.filter((entry) => !added.includes(entry));
    const sharedNames = summarizeSharedSubscriptionNames(rawSubscriptions.map(({ subscription }) => subscription));
    const rawCheckpointIdentities = rawSubscriptions
      .map(
        ({ subscription }) =>
          `${subscription.projectionName}:${subscription.sourceContextName}:v${subscription.subscriptionVersion}`,
      )
      .sort();

    expect(runtime.subscriptionRunners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceContextName: "marketplace",
          targetContextName: "marketplace",
          projectionName: "marketplace-offer-policy-projection",
        }),
        expect.objectContaining({
          sourceContextName: "marketplace",
          targetContextName: "marketplace",
          projectionName: "marketplace-managed-offer-projection",
          checkpointKey: "marketplace-managed-offer-projection:marketplace:v1",
        }),
        expect.objectContaining({
          sourceContextName: "pricing",
          targetContextName: "marketplace",
          projectionName: "marketplace-managed-offer-reaction",
          checkpointKey: "marketplace-managed-offer-reaction:pricing:v1",
          eventTypes: ["pricing.market-price.estimated"],
        }),
      ]),
    );
    expect(runtime.projectionGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: "marketplace",
          projectionName: "marketplace-managed-offer-projection",
          projectionRevision: 2,
        }),
      ]),
    );
    const fundingProjectionNames = ["payments-wallet-funding-projection", "platform-policy-document-projection"];
    const fundingRunners = runtime.subscriptionRunners.filter(
      (runner) => runner.targetContextName === "payments" && fundingProjectionNames.includes(runner.projectionName),
    );
    const listingDirectiveRunners = runtime.subscriptionRunners.filter(
      (runner) =>
        runner.targetContextName === "marketplace" &&
        runner.projectionName === "marketplace-listing-moderation-reaction",
    );
    expect(listingDirectiveRunners.map((runner) => runner.checkpointKey)).toEqual([
      "marketplace-listing-moderation-reaction:platform-operations:v1",
    ]);
    const inheritedRunners = runtime.subscriptionRunners.filter(
      (runner) => !fundingRunners.includes(runner) && !listingDirectiveRunners.includes(runner),
    );
    expect(fundingRunners.map((runner) => runner.checkpointKey).sort()).toEqual([
      "payments-wallet-funding-projection:payments:v1",
      "platform-policy-document-projection:payments:v1",
    ]);
    // #9392 adds exactly one runner: Platform Operations' own Support evidence cleanup locator.
    expect(
      inheritedRunners
        .filter((runner) => runner.projectionName === "support-evidence-cleanup-locator-projection")
        .map((runner) => runner.checkpointKey),
    ).toEqual(["support-evidence-cleanup-locator-projection:platform-operations:v1"]);
    // #9638 adds exactly one runner: Pricing's own forecast ledger.
    expect(
      inheritedRunners
        .filter((runner) => runner.projectionName === "pricing-forecast-ledger-projection")
        .map((runner) => runner.checkpointKey),
    ).toEqual(["pricing-forecast-ledger-projection:pricing:v1"]);
    expect(
      fingerprint(inheritedRunners.map((runner) => fingerprintObject(withoutAddedConsumerEvents(runner)))),
    ).toEqual({
      count: 256,
      sha256: "e1bcbbdfdf0765defa95110a7a333e19ffc36cb35b103d878cb83ceda8d9e544",
    });
    const proofCreditEventType = "settlement.wallet.staging-proof-credit-posted";
    const proofCreditRunners = inheritedRunners.filter((runner) => runner.eventTypes?.includes(proofCreditEventType));
    expect(proofCreditRunners.map((runner) => runner.checkpointKey)).toEqual([
      "settlement-wallet-projection:settlement:v1",
    ]);
    expect(
      fingerprint(
        inheritedRunners.map((runner) =>
          fingerprintObject(
            proofCreditRunners.includes(runner)
              ? {
                  ...withoutAddedConsumerEvents(runner),
                  eventTypes: runner.eventTypes?.filter(
                    (eventType) => eventType !== proofCreditEventType && eventType !== OPERATOR_REMOVAL,
                  ),
                  handlers: Object.fromEntries(
                    Object.entries(runner.handlers ?? {}).filter(
                      ([eventType]) => eventType !== proofCreditEventType && eventType !== OPERATOR_REMOVAL,
                    ),
                  ),
                }
              : withoutAddedConsumerEvents(runner),
          ),
        ),
      ),
    ).toEqual({
      count: 256,
      sha256: "544736446622d626972c650b5cc91480122777629388fbdf31e0172cde26994b",
    });
    expect(
      fingerprint(
        rawSubscriptions.map(({ targetContextName, subscription }) => ({
          targetContextName,
          subscription: fingerprintObject(withoutAddedConsumerEvents(subscription)),
        })),
      ),
    ).toEqual({
      count: 159,
      sha256: "c3e7699411661926a03f1e2be17800ce8b8c750907a844abf49ef6feb7749bb5",
    });
    expect({
      count: rawCheckpointIdentities.length,
      sha256: sha256(JSON.stringify(rawCheckpointIdentities)),
    }).toEqual({
      count: 159,
      sha256: "ee3830e0000be54e6c457eef282d01afdb88d79cb3b55fef0ca41bcb777e15d7",
    });
    expect(fingerprint(inheritedRunners.map((runner) => runner.checkpointKey))).toEqual({
      count: 256,
      sha256: "36b8c77302ef82d50a7d8dd2bb4426ae9cb720a16d8b45d4aacd31a1cc70e9d0",
    });
    expect(sharedNames).toMatchObject({
      distinctNames: 123,
      distinctSharedNames: 21,
      runnersUsingSharedNames: 57,
    });
    expect(sharedNames.values["checkout.checkout.sell-list-projection"]).toBe(3);
    expect(sharedNames.values["support.affected-line-amount-projection"]).toBe(2);
    // One projection, two source declarations: Ordering and Payments share the name.
    expect(sharedNames.values["platform-operations.seller-compliance-sales-projection"]).toBe(2);
  });

  it("boots the landing worker with source-only contexts required by active subscriptions", () => {
    const runtime = createPlatformWorkerHost("landing");

    expect(runtime.mountedContexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contextName: "ordering", mountRole: "source-only" }),
        expect.objectContaining({ contextName: "platform-operations", mountRole: "active" }),
        expect.objectContaining({ contextName: "public-presence", mountRole: "active" }),
      ]),
    );
    expect(runtime.projectionGroups.map((group) => `${group.targetContextName}:${group.projectionName}`)).toEqual(
      expect.arrayContaining([
        "platform-operations:support-order-source-projection",
        "public-presence:public-presence-waitlist-projection",
      ]),
    );
  });

  it("mounts the Payments funding and policy checkpoints with their exact interests and disable precedence", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    const targets = [
      {
        projectionName: "payments-wallet-funding-projection",
        streamPrefixes: ["payments."],
        ownedTables: ["payments_wallet_funding_pages"],
        eventTypes: [
          "payments.wallet-funding-authorized",
          "payments.wallet-funding-cancelled",
          "payments.wallet-funding-captured",
          "payments.wallet-funding-created",
          "payments.wallet-funding-dispute-recorded",
          "payments.wallet-funding-failed",
          "payments.wallet-funding-fraud-warning-recorded",
          "payments.wallet-funding-quoted",
          "payments.wallet-funding-refund-attention-recorded",
          "payments.wallet-funding-refund-operation-recorded",
          "payments.wallet-funding-refunded",
          "payments.wallet-funding-submission-claimed",
        ],
      },
      {
        projectionName: "platform-policy-document-projection",
        streamPrefixes: ["platform-policy.document-"],
        ownedTables: ["platform_policy_document_history", "platform_policy_documents"],
        eventTypes: ["platform-policy.document.created", "platform-policy.document.revised"],
      },
    ];
    const disabled = buildPlatformWorkerProjectionWakeRelayInterestIndex(
      targets.map(({ projectionName }) => `payments:${projectionName}`),
    );
    for (const target of targets) {
      const entries = index.entries.filter(
        (entry) => entry.targetContextName === "payments" && entry.projectionName === target.projectionName,
      );
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry).toMatchObject({
        ...target,
        sourceContextName: "payments",
        targetContextName: "payments",
        checkpointKey: `${target.projectionName}:payments:v1`,
        subscriptionName: `payments.${target.projectionName}`,
        subscriptionVersion: 1,
        owner: "Payments",
        enabled: true,
        priorityLane: "standard",
        optOutReason: null,
      });
      expect(entry.eventTypes).toEqual(target.eventTypes);
      expect(entry.streamPrefixes).toEqual(target.streamPrefixes);
      for (const eventType of target.eventTypes) {
        expect(lookupProjectionInterests(index, { sourceContextName: "payments", eventType })).toContain(entry);
        expect(lookupProjectionInterests(index, { sourceContextName: "platform-operations", eventType })).not.toContain(
          entry,
        );
      }
      expect(
        lookupProjectionInterests(index, { sourceContextName: "payments", eventType: "payments.payment-captured" }),
      ).not.toContain(entry);
      expect(disabled.entries.find((candidate) => candidate.entryId === entry.entryId)).toMatchObject({
        checkpointKey: entry.checkpointKey,
        enabled: false,
        optOutReason: "Disabled by WORKER_WAKE_DISABLED_PROJECTIONS.",
      });
    }
  });

  it("wires ordering.order.created to the Inventory order reservation workflow checkpoint", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();

    const entries = lookupProjectionInterests(index, {
      sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
      eventType: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType,
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.targetContextName,
          projectionName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.projectionName,
          checkpointKey: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.checkpointKey,
          sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
          enabled: true,
          eventTypes: expect.arrayContaining([ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType]),
        }),
      ]),
    );
  });

  it("wires an Inventory allocation commit to its exact production projection partition", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    const entries = lookupProjectionInterests(index, {
      sourceContextName: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.sourceContextName,
      eventType: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.eventType,
    });

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.targetContextName,
          projectionName: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.projectionName,
          checkpointKey: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.checkpointKey,
          sourceContextName: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.sourceContextName,
          enabled: true,
          eventTypes: [INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.eventType],
        }),
      ]),
    );
    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "inventory",
        eventType: "inventory.item.adjusted",
      }).some(
        (entry) =>
          entry.targetContextName === INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.targetContextName &&
          entry.projectionName === INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.projectionName,
      ),
    ).toBe(false);
    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "catalog",
        eventType: INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.eventType,
      }).some(
        (entry) =>
          entry.targetContextName === INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.targetContextName &&
          entry.projectionName === INVENTORY_CHANNEL_STOCK_ALLOCATION_TARGET.projectionName,
      ),
    ).toBe(false);
  });

  it("subscribes the Auth agent webhook projection to order, shipment, and refund updates", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();

    for (const target of AGENT_WEBHOOK_TARGETS) {
      const entries = lookupProjectionInterests(index, {
        sourceContextName: target.sourceContextName,
        eventType: target.eventType,
      });

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetContextName: target.targetContextName,
            projectionName: target.projectionName,
            checkpointKey: target.checkpointKey,
            sourceContextName: target.sourceContextName,
            enabled: true,
            eventTypes: expect.arrayContaining([target.eventType]),
          }),
        ]),
      );
    }
  });

  it("wires shipment dispatched to the Notifications v2 checkpoint", () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();

    for (const eventType of NOTIFICATIONS_FULFILLMENT_TARGET.eventTypes) {
      const entries = lookupProjectionInterests(index, {
        sourceContextName: NOTIFICATIONS_FULFILLMENT_TARGET.sourceContextName,
        eventType,
      });

      expect(entries, eventType).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetContextName: NOTIFICATIONS_FULFILLMENT_TARGET.targetContextName,
            projectionName: NOTIFICATIONS_FULFILLMENT_TARGET.projectionName,
            checkpointKey: NOTIFICATIONS_FULFILLMENT_TARGET.checkpointKey,
            sourceContextName: NOTIFICATIONS_FULFILLMENT_TARGET.sourceContextName,
            enabled: true,
            eventTypes: expect.arrayContaining([...NOTIFICATIONS_FULFILLMENT_TARGET.eventTypes]),
          }),
        ]),
      );
      // The retired v1 cursor is no longer woken for this projection.
      expect(
        entries.map((entry) => entry.checkpointKey),
        eventType,
      ).not.toContain("notifications-source-facts-outbox-projection:fulfillment:v1");
    }

    // Prior interests in the dispatched fact are retained alongside the new one.
    expect(
      lookupProjectionInterests(index, {
        sourceContextName: "fulfillment",
        eventType: "fulfillment.shipment.dispatched",
      }).map((entry) => entry.checkpointKey),
    ).toEqual(expect.arrayContaining(["auth-agent-order-webhook-projection:fulfillment:v1"]));
  });

  it("fans an Ordering created notification to Inventory instead of skipping as no-interests", async () => {
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    const enqueuedInputs: Parameters<ProjectionWakeRelayWorkSignalStore["enqueueProjectionWakeIntent"]>[0][] = [];

    const result = await fanOutEventStoreWakeNotification({
      notification: {
        schemaVersion: 1,
        payloadVersion: 1,
        kind: "event-store.commit",
        source: "event-core-postgres",
        emittedAt: parseIsoUtcTimestamp("2026-06-26T12:00:00.000Z"),
        correlationId: "trace_ordering_created_1",
        payload: {
          sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
          streamCategory: "ordering.order",
          firstGlobalPosition: parseGlobalPosition("71"),
          lastGlobalPosition: parseGlobalPosition("71"),
          eventCount: 1,
          eventTypes: [ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.eventType],
        },
      },
      projectionInterestIndex: index,
      workSignalStore: {
        enqueueProjectionWakeIntent: async (input) => {
          enqueuedInputs.push(input);
          return {
            wakeIntentId: `wake-${enqueuedInputs.length}`,
            coalescingKey: `coalescing-${enqueuedInputs.length}`,
            sourceContextName: input.sourceContextName,
            targetContextName: input.targetContextName,
            projectionName: input.projectionName,
            checkpointKey: input.checkpointKey,
            requiredPosition: BigInt(input.requiredPosition),
            requiredCursor: input.requiredCursor ?? null,
            priorityLane: input.priorityLane ?? "standard",
            origin: input.origin,
            schemaVersion: input.schemaVersion ?? 1,
            payloadVersion: input.payloadVersion ?? 1,
            correlationId: input.correlationId ?? null,
            metadata: input.metadata ?? {},
            state: "queued",
            claimOwnerId: null,
            claimFencingToken: null,
            claimedRequiredPosition: null,
            claimedRequiredCursor: null,
            claimedUntil: null,
            nextEligibleAt: new Date("2026-06-26T12:00:00.000Z"),
            attemptCount: 0,
            lastError: null,
            createdAt: new Date("2026-06-26T12:00:00.000Z"),
            updatedAt: new Date("2026-06-26T12:00:00.000Z"),
            expiresAt: new Date("2026-06-26T12:05:00.000Z"),
            completedAt: null,
          };
        },
      },
      relayConfigs: listSourceContextWakeRelayConfigs(),
    });

    expect(result).toMatchObject({
      status: "enqueued",
      skippedReason: null,
      sourceContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.sourceContextName,
      requiredCursor: "ordering:71",
    });
    expect(enqueuedInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetContextName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.targetContextName,
          projectionName: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.projectionName,
          checkpointKey: ORDERING_CREATED_INVENTORY_RESERVATION_TARGET.checkpointKey,
          requiredPosition: "71",
          requiredCursor: "ordering:71",
          priorityLane: "hot",
          origin: "relay",
        }),
      ]),
    );
  });
});

function buildPlatformWorkerProjectionWakeRelayInterestIndex(disabledProjectionKeys: readonly string[] = []) {
  const runtime = createPlatformWorkerHost();

  return buildProjectionInterestIndex({
    projectionGroups: runtime.projectionGroups,
    projectionOverrides: [
      ...disabledProjectionKeys.map((projectionKey) => {
        const separatorIndex = projectionKey.indexOf(":");
        return {
          targetContextName: projectionKey.slice(0, separatorIndex),
          projectionName: projectionKey.slice(separatorIndex + 1),
          disabled: true,
          optOutReason: "Disabled by WORKER_WAKE_DISABLED_PROJECTIONS.",
        };
      }),
      ...listProjectionInterestOverridesForPushMigration(),
    ],
  });
}

function createPlatformWorkerHost(runtimeProfile: "landing" | "proof" | "public" = "public") {
  return createWorkerHost(workerContextRegistry, "platform-worker", {
    pools: Object.fromEntries(workerContextRegistry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts: {
      capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
      draftListingCreator: { createDraftListings: async () => [] },
      // Real-registry composition: the worker states the Ordering
      // cleanup-authority capability explicitly as not-mounted (#7222).
      inventoryCleanupAuthority: { kind: "not-mounted" },
      channelSaleRecorder: createPlatformChannelSaleRecorder(createUnusedPool()),
      notificationAdapter: { send: async () => undefined },
      agentWebhookOrderResolvers: {
        resolveOrderRecipient: async () => null,
        resolveShipmentOrderId: async () => null,
        resolveWebhookTargets: async () => [],
      },
      ...syntheticPricingHostPorts,
    },
    runtimeProfile,
  });
}

function createUnusedPool() {
  const fail = () => {
    throw new Error("The platform-worker wake interest graph test must not touch database pools.");
  };

  return {
    query: fail,
    connect: fail,
  } as never;
}

type FingerprintRecord = Readonly<Record<string, unknown>>;

function addedConsumerEventTypes(value: FingerprintRecord): readonly string[] {
  if (value.sourceContextName !== "marketplace") return [];
  return [
    ...(REMOVAL_CONSUMERS.some(([, name]) => name === value.projectionName) ? [OPERATOR_REMOVAL] : []),
    ...(OFFER_LIFECYCLE_CONSUMERS.some(([, name]) => name === value.projectionName) ? OFFER_LIFECYCLE_EVENTS : []),
  ];
}

function withoutAddedConsumerEvents(value: FingerprintRecord) {
  const added = addedConsumerEventTypes(value);
  if (added.length === 0) return value;
  return {
    ...value,
    ...(Array.isArray(value.eventTypes)
      ? { eventTypes: value.eventTypes.filter((type) => !added.includes(type)) }
      : {}),
    ...(isRecord(value.handlers)
      ? { handlers: Object.fromEntries(Object.entries(value.handlers).filter(([type]) => !added.includes(type))) }
      : {}),
  };
}

function fingerprintObject(value: FingerprintRecord) {
  const fieldNames = Object.keys(value)
    .filter((fieldName) => typeof value[fieldName] !== "function")
    .sort();
  const handlerEventTypes = isRecord(value.handlers) ? Object.keys(value.handlers).sort() : [];

  return {
    fieldNames,
    fields: Object.fromEntries(fieldNames.map((fieldName) => [fieldName, stableValue(value[fieldName])])),
    handlerEventTypes,
  };
}

function fingerprint(values: readonly unknown[]) {
  const serialized = JSON.stringify(
    [...values].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
  return {
    count: values.length,
    sha256: sha256(serialized),
  };
}

function summarizeSharedSubscriptionNames(subscriptions: readonly Readonly<{ subscriptionName: string }>[]) {
  const counts = new Map<string, number>();
  for (const subscription of subscriptions) {
    counts.set(subscription.subscriptionName, (counts.get(subscription.subscriptionName) ?? 0) + 1);
  }
  const sharedNames = [...counts.entries()].filter(([, count]) => count > 1);

  return {
    distinctNames: counts.size,
    distinctSharedNames: sharedNames.length,
    runnersUsingSharedNames: sharedNames.reduce((total, [, count]) => total + count, 0),
    values: Object.fromEntries(sharedNames),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value)) {
    return typeof value === "function" ? "<function>" : value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function isRecord(value: unknown): value is FingerprintRecord {
  return typeof value === "object" && value !== null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
