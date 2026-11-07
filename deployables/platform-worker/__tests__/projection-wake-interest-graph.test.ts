import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createNoopCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { PricingHostPorts } from "@chase-sets/pricing/server";
import type { BcApiModule, BcEventSubscription } from "@chase-sets/bounded-context-module";
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
import {
  createWorkerHost,
  type WorkerContextRegistry,
  type WorkerHostRuntime,
  type WorkerHostRuntimeProfile,
} from "@chase-sets/platform-runtime/worker";
import { describe, expect, it } from "vitest";
import { workerContextRegistry } from "../src/generated/worker-context-registry";
import {
  assertWorkerAssembly,
  assertWorkerMembership,
  discoverWorkerContexts,
  loadOwnerContracts,
  type AdmittedContext,
  type OwnerContract,
} from "./worker-graph-contract";
import { syntheticConditionalWorkerExtension, syntheticWorkerExtension } from "./worker-graph-extension";
import { createPlatformChannelSaleRecorder } from "../src/channels-reconciliation-runners";
import {
  createFakeMoneyMovementGateway,
  createFakePaymentProcessorGateway,
  createSandboxPostageLabelProvider,
} from "../src/test-support/provider-gateways";

const syntheticPricingHostPorts = {
  commercialTermsResolver: createNoopCommercialTermsResolver(),
  channelConnectionIdentityReader: { resolve: async () => null },
} satisfies PricingHostPorts;

const admittedContexts = discoverWorkerContexts();
const ownerContracts = loadOwnerContracts(admittedContexts);

const OPERATOR_REMOVAL = "marketplace.listing.operator-unlisted";
const REMOVAL_CONSUMERS = [
  ["marketplace", "marketplace-listing-projection", 2],
  ["platform-operations", "account-appeal-interest-projection", 1],
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
  it("routes private account appeal lifecycle events to their same-context owner", () => {
    const runtime = createPlatformWorkerHost();
    const projectionName = "account-appeal-projection";
    const eventTypes = [
      "platform-operations.account-appeal.filed",
      "platform-operations.account-appeal.review-started",
      "platform-operations.account-appeal.outcome-recorded",
      "platform-operations.account-appeal.withdrawn",
    ];
    const runner = runtime.subscriptionRunners.find(
      (entry) => entry.sourceContextName === "platform-operations" && entry.projectionName === projectionName,
    );
    expect(runner).toMatchObject({
      targetContextName: "platform-operations",
      checkpointKey: `${projectionName}:platform-operations:v1`,
      streamPrefixes: undefined,
    });
    expect([...(runner?.eventTypes ?? [])].sort()).toEqual([...eventTypes].sort());
    const index = buildPlatformWorkerProjectionWakeRelayInterestIndex();
    for (const eventType of eventTypes) {
      expect(runner?.handlers?.[eventType]).toBeTypeOf("function");
      expect(
        lookupProjectionInterests(index, { sourceContextName: "platform-operations", eventType }).map(
          (entry) => `${entry.targetContextName}:${entry.projectionName}`,
        ),
      ).toContain(`platform-operations:${projectionName}`);
    }
  });

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
    const checkoutIdentityRunner = runtime.subscriptionRunners.find(
      (runner) =>
        runner.targetContextName === "checkout" &&
        runner.projectionName === "checkout-seller-accounts-projection" &&
        runner.sourceContextName === "identity",
    );
    expect(checkoutIdentityRunner).toMatchObject({
      checkpointKey: "checkout-seller-accounts-projection:identity:v2",
      subscriptionVersion: 2,
      eventTypes: expect.arrayContaining([
        "identity.account.suspended",
        "identity.account.reactivated",
        "identity.account.closed",
      ]),
    });
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
    // #9783 moves pricing-catalog-input-projection to catalog v8 (+7 Product Line event types).
    const productLineRunner = inheritedRunners.find(
      (runner) => runner.projectionName === "pricing-catalog-input-projection",
    );
    expect(productLineRunner).toMatchObject({
      checkpointKey: "pricing-catalog-input-projection:catalog:v8",
      subscriptionVersion: 8,
      eventTypes: expect.arrayContaining([
        "catalog.catalog-item.field-value-set",
        "catalog.catalog-item.field-value-cleared",
        "catalog.reference-record.created",
        "catalog.reference-record.revised",
        "catalog.reference-record.published",
        "catalog.reference-record.deprecated",
        "catalog.reference-record.archived",
      ]),
    });
  });

  it("worker assembly covers every owner contract", () => {
    for (const profile of ["landing", "proof", "public"] as const) {
      verifyAssembly(workerContextRegistry, ownerContracts, admittedContexts, profile);
    }
  });

  it("worker assembly rejects missing and misrouted members", () => {
    expect(
      () => verifyAssembly([...workerContextRegistry, workerContextRegistry[0]]),
      "duplicate registration",
    ).toThrow();
    for (const context of admittedContexts) {
      const registry = workerContextRegistry.filter((entry) => entry.contextName !== context.contextName);
      expect(() => verifyAssembly(registry), context.contextName).toThrow();
      expect(
        () =>
          verifyAssembly(
            registry,
            ownerContracts.filter((owner) => owner.contextName !== context.contextName),
          ),
        `${context.contextName}: registry and expectation removed together`,
      ).toThrow();
      expect(
        () =>
          verifyAssembly(
            workerContextRegistry,
            ownerContracts.filter((owner) => owner.contextName !== context.contextName),
          ),
        `${context.contextName}: missing owner contract`,
      ).toThrow();
    }

    const changeCheckout = (change: (module: BcApiModule) => BcApiModule): WorkerContextRegistry =>
      workerContextRegistry.map((entry) =>
        entry.contextName === "checkout" ? { ...entry, module: change(entry.module) } : entry,
      );
    const changeSubscriptions = (
      change: (subscriptions: readonly BcEventSubscription[]) => readonly BcEventSubscription[],
    ) =>
      changeCheckout((module) => ({
        ...module,
        buildSubscriptions: (services) => change(module.buildSubscriptions!(services)),
      }));
    const mutations: readonly [string, WorkerContextRegistry][] = [
      ["missing subscription", changeSubscriptions((subscriptions) => subscriptions.slice(1))],
      [
        "missing self-subscription",
        changeSubscriptions((subscriptions) =>
          subscriptions.filter((subscription) => subscription.sourceContextName !== "checkout"),
        ),
      ],
      ["duplicate subscription", changeSubscriptions((subscriptions) => [...subscriptions, subscriptions[0]])],
      [
        "missing handler",
        changeSubscriptions((subscriptions) =>
          subscriptions.map((subscription, index) =>
            index
              ? subscription
              : { ...subscription, handlers: Object.fromEntries(Object.entries(subscription.handlers).slice(1)) },
          ),
        ),
      ],
      [
        "missing event",
        changeSubscriptions((subscriptions) =>
          subscriptions.map((subscription, index) =>
            index ? subscription : { ...subscription, eventTypes: subscription.eventTypes?.slice(1) },
          ),
        ),
      ],
      [
        "wrong source",
        changeSubscriptions((subscriptions) =>
          subscriptions.map((subscription, index) =>
            index ? subscription : { ...subscription, sourceContextName: "auth" },
          ),
        ),
      ],
      [
        "wrong version",
        changeSubscriptions((subscriptions) =>
          subscriptions.map((subscription, index) =>
            index ? subscription : { ...subscription, subscriptionVersion: subscription.subscriptionVersion + 1 },
          ),
        ),
      ],
      [
        "missing version",
        changeSubscriptions((subscriptions) =>
          subscriptions.map((subscription, index) => {
            if (index) return subscription;
            const malformed = { ...subscription };
            Reflect.deleteProperty(malformed, "subscriptionVersion");
            return malformed;
          }),
        ),
      ],
      [
        "missing local projector",
        changeCheckout((module) => ({
          ...module,
          projectionHandlerSets: (services) =>
            module.projectionHandlerSets!(services).filter(
              (set) => set.projectionName !== "checkout.session-projection",
            ),
        })),
      ],
      [
        "missing implementation export",
        changeCheckout((module) => {
          const malformed = { ...module };
          Reflect.deleteProperty(malformed, "createServices");
          return malformed;
        }),
      ],
      ["malformed context", changeCheckout((module) => ({ ...module, contextName: "synthetic-wrong-context" }))],
    ];
    for (const [label, registry] of mutations) expect(() => verifyAssembly(registry), label).toThrow();

    const runtime = verifyAssembly();
    const brokenAssemblies: readonly [string, WorkerHostRuntime][] = [
      [
        "missing checkpoint",
        {
          ...runtime,
          subscriptionRunners: runtime.subscriptionRunners.map((runner, index) =>
            index
              ? runner
              : (() => {
                  const malformed = { ...runner };
                  Reflect.deleteProperty(malformed, "checkpointKey");
                  return malformed;
                })(),
          ),
        },
      ],
      [
        "duplicate runner",
        { ...runtime, subscriptionRunners: [...runtime.subscriptionRunners, runtime.subscriptionRunners[0]] },
      ],
      [
        "wrong target",
        {
          ...runtime,
          subscriptionRunners: runtime.subscriptionRunners.map((runner, index) =>
            index ? runner : { ...runner, targetContextName: "checkout" },
          ),
        },
      ],
      [
        "missing interest edge",
        {
          ...runtime,
          projectionGroups: runtime.projectionGroups.map((group, index) =>
            index ? group : { ...group, subscriptionRunners: group.subscriptionRunners.slice(1) },
          ),
        },
      ],
      [
        "misrouted interest edge",
        {
          ...runtime,
          projectionGroups: runtime.projectionGroups.map((group, index) =>
            index ? group : { ...group, targetContextName: "synthetic-wrong-target" },
          ),
        },
      ],
    ];
    for (const [label, broken] of brokenAssemblies)
      expect(() => assertWorkerAssembly(broken, admittedContexts, ownerContracts, "public"), label).toThrow();
  });

  it("owner contracts retain the previous graph coverage", () => {
    // Before -> after: runner fingerprints -> owner.runners; declared subscription
    // fingerprints -> owner.subscriptions; identities -> their projection/source/
    // version fields; checkpoint keys -> owner.runners[].checkpointKey.
    verifyOwnerCoverage(workerContextRegistry, ownerContracts, admittedContexts);
  });

  it("valid owner extension needs no global fingerprint edit", () => {
    const extensions = [
      ...(["all-profiles", "landing-only", "source-only"] as const).map((mode) => [
        syntheticWorkerExtension(false, mode),
      ]),
      syntheticConditionalWorkerExtension(),
    ];
    for (const additions of extensions) {
      const contexts = [...admittedContexts, ...additions.map((extension) => extension.context)];
      const contracts = [...ownerContracts, ...additions.map((extension) => extension.contract)];
      const registry = [...workerContextRegistry, ...additions.map((extension) => extension.registration)];
      verifyOwnerCoverage(registry, contracts, contexts);
      for (const { context } of additions) {
        const missingRegistration = registry.filter((entry) => entry.contextName !== context.contextName);
        const missingContract = contracts.filter((owner) => owner.contextName !== context.contextName);
        expect(
          () => verifyAssembly(missingRegistration, contracts, contexts),
          `${context.contextName}: missing registration`,
        ).toThrow();
        expect(
          () => verifyAssembly(missingRegistration, missingContract, contexts),
          `${context.contextName}: missing both`,
        ).toThrow();
        expect(
          () => verifyAssembly(registry, missingContract, contexts),
          `${context.contextName}: missing contract`,
        ).toThrow();
      }
    }

    const extension = syntheticWorkerExtension();
    const contexts = [...admittedContexts, extension.context];
    const contracts = [...ownerContracts, extension.contract];
    // An additional handler changes only the synthetic owner's literal contract.
    const extended = syntheticWorkerExtension(true);
    verifyAssembly([...workerContextRegistry, extended.registration], [...ownerContracts, extended.contract], contexts);
    expect(() => verifyAssembly([...workerContextRegistry, extended.registration], contracts, contexts)).toThrow();
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

  it("assembles the conditional owner's runner only where its source is mounted", () => {
    const extensions = syntheticConditionalWorkerExtension();
    for (const profile of ["public", "proof", "landing"] as const) {
      const runtime = verifyAssembly(
        extensions.map(({ registration }) => registration),
        extensions.map(({ contract }) => contract),
        extensions.map(({ context }) => context),
        profile,
      );
      expect(runtime.mountedContexts).toContainEqual(
        expect.objectContaining({ contextName: "synthetic-conditional-owner", mountRole: "active" }),
      );
      expect(
        runtime.subscriptionRunners
          .filter((runner) => runner.targetContextName === "synthetic-conditional-owner")
          .map((runner) => runner.checkpointKey),
        `${profile}: conditional runner`,
      ).toEqual(profile === "landing" ? ["synthetic-conditional-projection:synthetic-worker-extension:v1"] : []);
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

function createPlatformWorkerHost(
  runtimeProfile: WorkerHostRuntimeProfile = "public",
  registry: WorkerContextRegistry = workerContextRegistry,
) {
  return createWorkerHost(registry, "platform-worker", {
    pools: Object.fromEntries(registry.map((entry) => [entry.contextName, createUnusedPool()])),
    hostPorts: {
      capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
      processorGateway: createFakePaymentProcessorGateway(),
      moneyMovementGateway: createFakeMoneyMovementGateway(),
      operationsRecorder: { record: () => undefined },
      postageLabelProvider: createSandboxPostageLabelProvider(),
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

function verifyAssembly(
  registry: WorkerContextRegistry = workerContextRegistry,
  contracts: readonly OwnerContract[] = ownerContracts,
  contexts: readonly AdmittedContext[] = admittedContexts,
  profile: WorkerHostRuntimeProfile = "public",
) {
  const runtime = createPlatformWorkerHost(profile, registry);
  assertWorkerMembership(contexts, contracts, registry);
  assertWorkerAssembly(runtime, contexts, contracts, profile);
  return runtime;
}

function verifyOwnerCoverage(
  registry: WorkerContextRegistry,
  contracts: readonly OwnerContract[],
  contexts: readonly AdmittedContext[],
) {
  const assemblies = (["public", "proof", "landing"] as const).map((profile) => ({
    profile,
    runtime: verifyAssembly(registry, contracts, contexts, profile),
  }));
  for (const owner of contracts) {
    const active = assemblies.some(({ runtime }) =>
      runtime.mountedContexts.some(
        (context) => context.contextName === owner.contextName && context.mountRole === "active",
      ),
    );
    // Source-only owners have no active graph to mutate; membership and source
    // mounting are still checked by verifyAssembly in every profile above.
    if (!active) {
      expect(owner.runners, `${owner.contextName}: source-only runners`).toEqual([]);
      expect(owner.subscriptions, `${owner.contextName}: source-only subscriptions`).toEqual([]);
      continue;
    }
    const changedContracts: [string, OwnerContract][] = [];
    const runner = owner.runners[0];
    if (runner) {
      changedContracts.push(
        ["runner", { ...owner, runners: owner.runners.filter((candidate) => candidate !== runner) }],
        [
          "checkpoint identity",
          {
            ...owner,
            runners: owner.runners.map((candidate) =>
              candidate === runner
                ? { ...candidate, subscriptionVersion: Number(candidate.subscriptionVersion) + 1 }
                : candidate,
            ),
          },
        ],
        [
          "checkpoint key",
          {
            ...owner,
            runners: owner.runners.map((candidate) =>
              candidate === runner ? { ...candidate, checkpointKey: "synthetic-wrong-checkpoint" } : candidate,
            ),
          },
        ],
      );
    }
    for (const [field, empty] of [
      ["eventTypes", []],
      ["handlers", {}],
    ] as const) {
      const populated = owner.runners.find((candidate) => Object.keys(candidate[field] ?? {}).length > 0);
      if (populated) {
        changedContracts.push([
          field,
          {
            ...owner,
            runners: owner.runners.map((candidate) =>
              candidate === populated ? { ...candidate, [field]: empty } : candidate,
            ),
          },
        ]);
      }
    }
    if (owner.subscriptions.length) {
      changedContracts.push(
        ["subscription", { ...owner, subscriptions: owner.subscriptions.slice(1) }],
        [
          "subscription version",
          {
            ...owner,
            subscriptions: owner.subscriptions.map((subscription, index) =>
              index
                ? subscription
                : { ...subscription, subscriptionVersion: Number(subscription.subscriptionVersion) + 1 },
            ),
          },
        ],
      );
    }
    for (const [category, changed] of changedContracts) {
      // An active owner may have a conditional runner absent from that profile.
      // Every baseline above is valid; each mutation must fail in at least one.
      const rejected = assemblies.some(({ profile, runtime }) => {
        try {
          assertWorkerAssembly(
            runtime,
            contexts,
            contracts.map((candidate) => (candidate.contextName === owner.contextName ? changed : candidate)),
            profile,
          );
          return false;
        } catch {
          return true;
        }
      });
      expect(rejected, `${owner.contextName}: changed ${category} expectation across runtime profiles`).toBe(true);
    }
  }
}
