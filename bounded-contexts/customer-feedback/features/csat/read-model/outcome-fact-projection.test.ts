import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  PaymentCapturedPayload,
  PayoutCompletedPayload,
  SupportRequestResolvedPayload,
  MarketplaceListingPublishedPayload,
  MarketplaceOfferAcceptedPayload,
  MarketplaceReviewSubmittedPayload,
  InventoryItemCreatedPayload,
  InventoryItemAdjustedPayload,
} from "@chase-sets/event-core/public-event-payloads";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentEvent,
} from "../../../../fulfillment/features/shipments/domain/domain";
import {
  evolvePayment,
  initialPaymentState,
  type PaymentEvent,
} from "../../../../payments/features/payments/domain/domain";
import {
  evolvePayout,
  initialPayoutState,
  type PayoutEvent,
} from "../../../../settlement/features/payouts/domain/domain";
import {
  evolveSupportRequest,
  initialSupportRequestState,
  type SupportRequestEvent,
} from "../../../../platform-operations/features/support-requests/domain/domain";
import { buildFulfillmentShipmentProjectionHandlers } from "../../../../fulfillment/features/shipments/read-model/projection";
import { buildPaymentProjectionHandlers } from "../../../../payments/features/payments/read-model/projection";
import { buildPayoutProjectionHandlers } from "../../../../settlement/features/payouts/read-model/projection";
import { buildSupportRequestProjectionHandlers } from "../../../../platform-operations/features/support-requests/read-model/projection";
import { outcomeHandlers, outcomeRows } from "../../../tests/outcome-fact-test-support";
import {
  listingFact,
  offerFact,
  reviewFact,
  inventoryCreatedFact,
  inventoryAdjustedFact,
  offlineSaleFacts,
  waveThreeOccurredAt,
} from "../../../tests/wave-three-outcome-fact-test-support";
import {
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../../../../marketplace/features/listings/domain/domain";
import {
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../../../marketplace/features/offers/domain/domain";
import {
  evolveReview,
  initialReviewState,
  type ReviewEvent,
} from "../../../../marketplace/features/reviews/domain/domain";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../../../../inventory/features/inventory-items/domain/domain";
import { buildMarketplaceListingProjectionHandlers } from "../../../../marketplace/features/listings/read-model/projection";
import { buildMarketplaceOfferProjectionHandlers } from "../../../../marketplace/features/offers/read-model/projection";
import { buildReviewProjectionHandlers } from "../../../../marketplace/features/reviews/read-model/projection";
import { buildInventoryItemProjectionHandlers } from "../../../../inventory/features/inventory-items/read-model/projection";
import {
  deliveryFact,
  captureFact,
  payoutFact,
  supportFact,
  outcomeOccurredAt,
} from "../../../tests/wave-two-outcome-fact-test-support";

const timing = { occurredAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:01.000Z" };
const audit = { performedByUserId: "usr_bootstrap", forAccountId: "acc_bootstrap" } as const;

describe("wave three native outcome facts", () => {
  it("keeps production event data assignable to the public payload exports", () => {
    expectTypeOf<ReturnType<typeof listingFact>["data"]>().toExtend<MarketplaceListingPublishedPayload>();
    expectTypeOf<ReturnType<typeof offerFact>["data"]>().toExtend<MarketplaceOfferAcceptedPayload>();
    expectTypeOf<ReturnType<typeof reviewFact>["data"]>().toExtend<MarketplaceReviewSubmittedPayload>();
    expectTypeOf<ReturnType<typeof inventoryCreatedFact>["data"]>().toExtend<InventoryItemCreatedPayload>();
    expectTypeOf<ReturnType<typeof inventoryAdjustedFact>["data"]>().toExtend<InventoryItemAdjustedPayload>();
  });
  const marketplaceCases = [
    [
      listingFact,
      [
        "marketplace:listing.published:lst_native",
        "listing.published",
        "marketplace",
        "acc_seller",
        "seller",
        "listing",
        "lst_native",
      ],
    ],
    [
      offerFact,
      [
        "marketplace:offer.accepted:off_native",
        "offer.accepted",
        "marketplace",
        "acc_seller",
        "seller",
        "offer",
        "off_native",
      ],
    ],
    [
      () => reviewFact("buyer"),
      [
        "review:rev_buyer:received",
        "reputation.review-received",
        "marketplace",
        "acc_buyer",
        "buyer",
        "review",
        "rev_buyer",
      ],
    ],
    [
      () => reviewFact("seller"),
      [
        "review:rev_seller:received",
        "reputation.review-received",
        "marketplace",
        "acc_seller",
        "seller",
        "review",
        "rev_seller",
      ],
    ],
  ] as const;

  it("projects Marketplace native events with helper-parity rows", async () => {
    for (const [emit, expected] of marketplaceCases) {
      const native = emit();
      expect(native.data).not.toHaveProperty("csatOutcomeFact");
      const store = outcomeRows();
      await outcomeHandlers[native.type]!(
        buildTransportEvent(native.type, native.data, { id: "evt_marketplace", timing, audit }),
        store,
      );
      expect([...store.rows.values()]).toEqual([
        [...expected, waveThreeOccurredAt, "evt_marketplace", "usr_bootstrap", null, null],
      ]);
    }
  });

  it("projects Inventory raw occurrences with stable event identities", async () => {
    const created = inventoryCreatedFact();
    const adjusted = inventoryAdjustedFact();
    const offline = offlineSaleFacts()[0]!;
    const external = decideInventoryItem(evolveInventoryItem(initialInventoryItemState, created), {
      type: "RecordExternalChannelSaleAdjustment",
      quantity: 1,
      heldQuantity: 0,
    })[0]!;
    const cases = [
      ["production creation / seed shape", created, "acc_payload_seller", null],
      ["production adjustment", adjusted, "acc_bootstrap", "intake"],
      ["production offline sale", offline, "acc_bootstrap", "sold-offline"],
      ["production external channel sale", external, "acc_bootstrap", "sold-external-channel"],
      [
        "historical adjustment without reason",
        { type: adjusted.type, data: { itemId: "inv_native", quantityDelta: -1, reason: "Legacy" } },
        "acc_bootstrap",
        null,
      ],
      [
        "other producer: holds consumption",
        {
          type: adjusted.type,
          data: { itemId: "inv_native", quantityDelta: -1, reason: "Sale", reasonCode: "sale-consumed" },
        },
        "acc_bootstrap",
        "sale-consumed",
      ],
    ] as const;
    const store = outcomeRows();
    for (const [label, native, account, reason] of cases) {
      const id = `evt_${label}`;
      await outcomeHandlers[native.type]!(buildTransportEvent(native.type, native.data, { id, timing, audit }), store);
      expect(store.rows.get(`inventory:item.adjusted:${id}`), label).toEqual([
        `inventory:item.adjusted:${id}`,
        "inventory.item-adjusted",
        "inventory",
        account,
        "seller",
        "inventory-item",
        "inv_native",
        timing.occurredAt,
        id,
        "usr_bootstrap",
        null,
        reason,
      ]);
    }
    expect(store.rows.size).toBe(cases.length);
  });

  it("redelivery preserves immutable outcome rows", async () => {
    for (const emit of [listingFact, offerFact, reviewFact, inventoryCreatedFact, inventoryAdjustedFact]) {
      const native = emit();
      const store = outcomeRows();
      const event = buildTransportEvent(native.type, native.data, { id: "evt_original", timing, audit });
      await outcomeHandlers[event.type]!(event, store);
      const before = [...store.rows.entries()];
      await outcomeHandlers[event.type]!(
        {
          ...event,
          data: {
            ...event.data,
            publishedAt: "2027-01-01T00:00:00Z",
            acceptedAt: "2027-01-01T00:00:00Z",
            submittedAt: "2027-01-01T00:00:00Z",
            reasonCode: "changed",
          },
          audit: { ...event.audit, performedByUserId: "usr_changed" as never },
          timing: { ...event.timing, occurredAt: "2027-01-01T00:00:00Z" as never },
        },
        store,
      );
      expect([...store.rows.entries()]).toEqual(before);
      expect(store.db.query).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT (idempotency_key) DO NOTHING"),
        expect.any(Array),
      );
      if (native.type.startsWith("inventory.")) {
        await outcomeHandlers[event.type]!({ ...event, id: "evt_distinct" as never }, store);
        expect(store.rows.size).toBe(2);
      }
    }
  });

  const legacyListing = {
    factSchemaVersion: 1,
    outcomeCode: "listing.published",
    sourceContext: "marketplace",
    subjectAccountId: "acc_legacy",
    subjectKind: "seller",
    subject: { entityType: "listing", entityId: "lst_legacy" },
    outcomeOccurredAt: "2025-01-01T00:00:00.000Z",
    idempotencyKey: "legacy-listing-key",
  };

  it("uses usable nested-only listing history, skips empty history and prefers native fields", async () => {
    const store = outcomeRows();
    const handler = outcomeHandlers["marketplace.listing.published"]!;
    for (const data of [
      {},
      { csatOutcomeFact: {} },
      { csatOutcomeFact: [] },
      { csatOutcomeFact: { ...legacyListing, subject: [] } },
      { csatOutcomeFact: { ...legacyListing, outcomeOccurredAt: "invalid" } },
    ]) {
      await handler(buildTransportEvent("marketplace.listing.published", data, { timing, audit }), store);
    }
    expect(store.rows.size).toBe(0);
    await handler(
      buildTransportEvent(
        "marketplace.listing.published",
        { csatOutcomeFact: legacyListing },
        { id: "evt_legacy", timing, audit },
      ),
      store,
    );
    expect(store.rows.get("legacy-listing-key")).toEqual([
      "legacy-listing-key",
      "listing.published",
      "marketplace",
      "acc_legacy",
      "seller",
      "listing",
      "lst_legacy",
      legacyListing.outcomeOccurredAt,
      "evt_legacy",
      "usr_bootstrap",
      null,
      null,
    ]);
    await handler(
      buildTransportEvent(
        "marketplace.listing.published",
        { ...listingFact().data, csatOutcomeFact: legacyListing },
        { id: "evt_native", timing, audit },
      ),
      store,
    );
    expect(store.rows.get("marketplace:listing.published:lst_native")?.slice(3, 9)).toEqual([
      "acc_seller",
      "seller",
      "listing",
      "lst_native",
      waveThreeOccurredAt,
      "evt_native",
    ]);
  });

  it("replays legacy Marketplace and Inventory history", async () => {
    const cases = [
      {
        native: listingFact(),
        historicalData: { csatOutcomeFact: legacyListing },
        projection: buildMarketplaceListingProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history
            .map(createPassthroughDomainEventCodec<MarketplaceListingEvent>().decode)
            .reduce(evolveMarketplaceListing, initialMarketplaceListingState),
      },
      {
        native: listingFact(),
        historicalData: {},
        empty: true,
        projection: buildMarketplaceListingProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history
            .map(createPassthroughDomainEventCodec<MarketplaceListingEvent>().decode)
            .reduce(evolveMarketplaceListing, initialMarketplaceListingState),
      },
      {
        native: offerFact(),
        projection: buildMarketplaceOfferProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history
            .map(createPassthroughDomainEventCodec<MarketplaceOfferEvent>().decode)
            .reduce(evolveMarketplaceOffer, initialMarketplaceOfferState),
      },
      {
        native: reviewFact(),
        sibling: true,
        projection: buildReviewProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history.map(createPassthroughDomainEventCodec<ReviewEvent>().decode).reduce(evolveReview, initialReviewState),
      },
      {
        native: inventoryCreatedFact(),
        projection: buildInventoryItemProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history
            .map(createPassthroughDomainEventCodec<InventoryItemEvent>().decode)
            .reduce(evolveInventoryItem, initialInventoryItemState),
      },
      {
        native: inventoryAdjustedFact(),
        projection: buildInventoryItemProjectionHandlers,
        fold: (history: readonly StoredEvent[]) =>
          history
            .map(createPassthroughDomainEventCodec<InventoryItemEvent>().decode)
            .reduce(evolveInventoryItem, initialInventoryItemState),
      },
    ];
    for (const entry of cases) {
      const memory = createInMemoryEventStore();
      const payload = entry.historicalData ?? { ...entry.native.data, csatOutcomeFact: legacyListing };
      await memory.eventStore.appendToStream({
        streamId: `${entry.native.type.split(".")[0]}.synthetic-history`,
        expectedVersion: "no_stream",
        context: { tenantId: "tnt_replay", audit },
        events: [
          { eventType: entry.native.type, payload },
          ...(entry.sibling ? [{ eventType: "marketplace.csat-outcome-fact.v1", payload: legacyListing }] : []),
        ],
      });
      const history = memory.readAllEvents();
      const plain = history.slice(0, 1).map((event) => ({ ...event, payload: entry.native.data }));
      expect(entry.fold(history)).toEqual(entry.fold(plain));
      const queries = [];
      for (const stream of [plain, history]) {
        const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
        const handlers = entry.projection({ query } as PgQueryable);
        for (const event of stream) await handlers[event.eventType]?.(toTransportEvent(event));
        queries.push(query.mock.calls);
      }
      expect(queries[1]).toEqual(queries[0]);
      const facts = outcomeRows();
      for (const event of history) await outcomeHandlers[event.eventType]?.(toTransportEvent(event), facts);
      expect(facts.rows.size).toBe(entry.empty ? 0 : 1);
      if (entry.native.type !== "marketplace.listing.published") {
        const nativeFacts = outcomeRows();
        const native = plain[0]!;
        await outcomeHandlers[native.eventType]!(toTransportEvent(native), nativeFacts);
        expect([...facts.rows.entries()]).toEqual([...nativeFacts.rows.entries()]);
      }
    }
    expect(outcomeHandlers["marketplace.csat-outcome-fact.v1"]).toBeUndefined();
  });
});

describe("legacy source replay", () => {
  const cases = [
    {
      source: "fulfillment",
      emit: deliveryFact,
      projection: buildFulfillmentShipmentProjectionHandlers,
      fold: (events: readonly StoredEvent[]) =>
        events
          .map(createPassthroughDomainEventCodec<FulfillmentShipmentEvent>().decode)
          .reduce(evolveFulfillmentShipment, initialFulfillmentShipmentState),
    },
    {
      source: "payments",
      emit: () => captureFact("checkout-recovery"),
      projection: buildPaymentProjectionHandlers,
      fold: (events: readonly StoredEvent[]) =>
        events.map(createPassthroughDomainEventCodec<PaymentEvent>().decode).reduce(evolvePayment, initialPaymentState),
    },
    {
      source: "settlement",
      emit: payoutFact,
      projection: buildPayoutProjectionHandlers,
      fold: (events: readonly StoredEvent[]) =>
        events.map(createPassthroughDomainEventCodec<PayoutEvent>().decode).reduce(evolvePayout, initialPayoutState),
    },
    {
      source: "platform-operations",
      emit: () => supportFact("return-request"),
      projection: buildSupportRequestProjectionHandlers,
      fold: (events: readonly StoredEvent[]) =>
        events
          .map(createPassthroughDomainEventCodec<SupportRequestEvent>().decode)
          .reduce(evolveSupportRequest, initialSupportRequestState),
    },
  ];
  it.each(cases)("$source replays a stream with legacy CSAT events", async ({ source, emit, fold, projection }) => {
    const native = emit();
    const legacy = {
      factSchemaVersion: 1,
      outcomeCode: "legacy",
      subject: { entityType: "support-request", entityId: "sup_native" },
    };
    const memory = createInMemoryEventStore();
    await memory.eventStore.appendToStream({
      streamId: `${source}.synthetic-history`,
      expectedVersion: "no_stream",
      context: { tenantId: "tnt_replay", audit },
      events: [
        {
          eventType: native.type,
          payload: source === "settlement" ? { ...native.data, csatOutcomeFact: legacy } : native.data,
        },
        ...(source === "settlement" ? [] : [{ eventType: `${source}.csat-outcome-fact.v1`, payload: legacy }]),
      ],
    });
    const history = memory.readAllEvents();
    expect(fold(history)).toEqual(fold(history.slice(0, 1)));
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const handlers = projection({ query } as PgQueryable);
    const facts = outcomeRows();
    for (const stored of history) {
      const event = toTransportEvent(stored);
      await handlers[event.type]?.(event);
      await outcomeHandlers[event.type]?.(event, facts);
    }
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE"), expect.any(Array));
    expect(facts.rows.size).toBe(1);
  });
});

describe("wave two native outcome facts", () => {
  it("keeps producer events assignable to the public payloads", () => {
    expectTypeOf<ReturnType<typeof captureFact>["data"]>().toExtend<PaymentCapturedPayload>();
    expectTypeOf<ReturnType<typeof payoutFact>["data"]>().toExtend<PayoutCompletedPayload>();
    expectTypeOf<ReturnType<typeof supportFact>["data"]>().toExtend<SupportRequestResolvedPayload>();
  });
  const cases = [
    [
      "fulfillment",
      deliveryFact,
      ["order:ord_native:delivered", "order.delivered", "fulfillment", "acc_buyer", "buyer", "order", "ord_native"],
    ],
    [
      "payments checkout-recovery",
      () => captureFact("checkout-recovery"),
      [
        "payment:pay_native:checkout.recovered",
        "checkout.recovered",
        "checkout",
        "acc_buyer",
        "buyer",
        "payment",
        "pay_native",
      ],
    ],
    [
      "payments other",
      () => captureFact("other"),
      [
        "payment:pay_native:checkout.completed",
        "checkout.completed",
        "checkout",
        "acc_buyer",
        "buyer",
        "payment",
        "pay_native",
      ],
    ],
    [
      "payments null",
      () => captureFact(null),
      [
        "payment:pay_native:checkout.completed",
        "checkout.completed",
        "checkout",
        "acc_buyer",
        "buyer",
        "payment",
        "pay_native",
      ],
    ],
    [
      "settlement",
      payoutFact,
      [
        "settlement:payout.completed:pyo_native",
        "payout.completed",
        "settlement",
        "acc_seller",
        "seller",
        "payout",
        "pyo_native",
      ],
    ],
    [
      "platform-operations support",
      () => supportFact("product-not-received"),
      [
        "support-request:sup_native:resolved",
        "support.request-resolved",
        "platform-operations",
        "acc_buyer",
        "buyer",
        "support-request",
        "sup_native",
      ],
    ],
    [
      "platform-operations return",
      () => supportFact("return-request"),
      [
        "support-request:sup_native:resolved",
        "return.resolved",
        "platform-operations",
        "acc_buyer",
        "buyer",
        "return",
        "sup_native",
      ],
    ],
  ] as const;

  it.each(cases)("projects %s with helper-parity row", async (_source, emit, expected) => {
    const native = emit();
    const event = buildTransportEvent(native.type, native.data, { id: "evt_native", timing, audit });
    const store = outcomeRows();
    const handler = outcomeHandlers[event.type]!;
    await handler(event, store);
    await handler(
      { ...event, id: "evt_redelivery" as never, audit: { ...event.audit, performedByUserId: "usr_changed" as never } },
      store,
    );
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(expected[0])).toEqual([
      ...expected,
      outcomeOccurredAt,
      "evt_native",
      "usr_bootstrap",
      null,
      null,
    ]);
    expect(store.db.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (idempotency_key) DO NOTHING"),
      expect.any(Array),
    );
  });

  it("skips historical captures without sourceContext, not explicit null", async () => {
    const native = captureFact(null);
    const { sourceContext: _sourceContext, ...historical } = native.data;
    const store = outcomeRows();
    await outcomeHandlers[native.type]!(buildTransportEvent(native.type, historical), store);
    expect(store.db.query).not.toHaveBeenCalled();
    await outcomeHandlers[native.type]!(buildTransportEvent(native.type, native.data), store);
    expect(store.rows.size).toBe(1);
  });

  it("ignores all legacy sibling facts and the payout nested fact", async () => {
    for (const context of ["fulfillment", "payments", "platform-operations"]) {
      expect(outcomeHandlers[`${context}.csat-outcome-fact.v1`]).toBeUndefined();
    }
    const native = payoutFact();
    const store = outcomeRows();
    await outcomeHandlers[native.type]!(
      buildTransportEvent(native.type, {
        ...native.data,
        csatOutcomeFact: { outcomeCode: "wrong", idempotencyKey: "legacy" },
      }),
      store,
    );
    expect([...store.rows.keys()]).toEqual(["settlement:payout.completed:pyo_native"]);
  });

  it.each(cases)("isolates %s projection failure from its source command", async (_source, emit) => {
    const native = emit();
    const original = structuredClone(native);
    const failure = new Error("synthetic projection failure");
    await expect(
      outcomeHandlers[native.type]!(buildTransportEvent(native.type, native.data), {
        db: {
          query: async () => {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(native).toEqual(original);
    expect(emit()).toEqual(original);
  });
});

const auth = buildTransportEvent(
  "auth.session.started",
  {
    sessionId: "ses_1" as never,
    userId: "usr_customer" as never,
    accountId: "acc_1" as never,
    availableAccountIds: ["acc_1"],
    authenticationMethod: "password",
    expiresAt: "2026-01-02T00:00:00.000Z",
  },
  { id: "evt_auth_1", timing, audit },
);

const fixtures = [
  {
    name: "auth.session.started",
    event: auth,
    row: [
      "auth:authentication:ses_1",
      "authentication.completed",
      "auth",
      "acc_1",
      "account",
      "session",
      "ses_1",
      timing.recordedAt,
      "evt_auth_1",
      "usr_bootstrap",
      "password",
      null,
    ],
  },
  {
    name: "identity.registration.completed",
    event: buildTransportEvent(
      "identity.registration.completed",
      { accountId: "acc_1" as never, userId: "usr_customer" as never },
      { id: "evt_registration", timing, audit },
    ),
    row: [
      "identity:registration:acc_1",
      "registration.completed",
      "identity",
      "acc_1",
      "account",
      "account",
      "acc_1",
      timing.recordedAt,
      "evt_registration",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "identity.onboarding.completed guest-account",
    event: buildTransportEvent(
      "identity.onboarding.completed",
      { accountId: "acc_1" as never, userId: "usr_customer" as never, onboardingPath: "guest-account" },
      { id: "evt_guest", timing, audit },
    ),
    row: [
      "identity:onboarding:guest-account:acc_1:usr_customer",
      "onboarding.completed",
      "identity",
      "acc_1",
      "account",
      "account",
      "acc_1",
      timing.recordedAt,
      "evt_guest",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "identity.onboarding.completed invitation",
    event: buildTransportEvent(
      "identity.onboarding.completed",
      {
        accountId: "acc_1" as never,
        userId: "usr_customer" as never,
        onboardingPath: "invitation",
        invitationId: "ivt_1",
      },
      { id: "evt_invitation", timing, audit },
    ),
    row: [
      "identity:onboarding:invitation:ivt_1:usr_customer",
      "onboarding.completed",
      "identity",
      "acc_1",
      "account",
      "invitation",
      "ivt_1",
      timing.recordedAt,
      "evt_invitation",
      "usr_bootstrap",
      null,
      null,
    ],
  },
  {
    name: "discovery.search-session.started",
    event: buildTransportEvent(
      "discovery.search-session.started",
      { accountId: "acc_1" as never, sessionId: "ses_1" as never },
      { id: "evt_search", timing, audit },
    ),
    row: [
      "discovery:search-session:ses_1",
      "discovery.search-completed",
      "discovery",
      "acc_1",
      "account",
      "session",
      "ses_1",
      timing.recordedAt,
      "evt_search",
      "usr_bootstrap",
      null,
      null,
    ],
  },
];

describe("CSAT outcome fact projection", () => {
  it.each(fixtures)("projects $name with helper-parity row", async ({ event, row }) => {
    const store = outcomeRows();
    await outcomeHandlers[event.type]!(event, store);
    expect(store.rows.get(String(row[0]))).toEqual(row);
    expect(store.db.query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (idempotency_key) DO NOTHING"),
      row,
    );
  });

  it("replay upserts one row per idempotency key", async () => {
    const store = outcomeRows();
    for (const { event } of fixtures) {
      const handler = outcomeHandlers[event.type]!;
      await handler(event, store);
      await handler(event, store);
    }
    expect(store.rows.size).toBe(fixtures.length);
    expect([...store.rows.values()]).toEqual(fixtures.map(({ row }) => row));
    expect(store.db.query).toHaveBeenCalledTimes(fixtures.length * 2);
  });

  it("projects raw source columns", async () => {
    const store = outcomeRows();
    // Explicitly synthetic missing-field history, not a valid typed Auth payload.
    const legacy = buildTransportEvent(
      "auth.session.started",
      {
        sessionId: "ses_synthetic_legacy",
        userId: "usr_legacy",
        accountId: "acc_legacy",
      } as never,
      { id: "evt_synthetic_legacy", timing, audit },
    );
    for (const event of [auth, legacy]) {
      await outcomeHandlers[event.type]!(event, store);
      await outcomeHandlers[event.type]!(event, store);
    }
    expect(store.rows.size).toBe(2);
    expect(store.rows.get("auth:authentication:ses_1")!.slice(7)).toEqual([
      timing.recordedAt,
      "evt_auth_1",
      "usr_bootstrap",
      "password",
      null,
    ]);
    expect(store.rows.get("auth:authentication:ses_synthetic_legacy")!.slice(7)).toEqual([
      timing.recordedAt,
      "evt_synthetic_legacy",
      "usr_bootstrap",
      null,
      null,
    ]);
  });
});
