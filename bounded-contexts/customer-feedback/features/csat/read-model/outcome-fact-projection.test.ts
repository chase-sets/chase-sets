import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type {
  PaymentCapturedPayload,
  PayoutCompletedPayload,
  SupportRequestResolvedPayload,
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
  deliveryFact,
  captureFact,
  payoutFact,
  supportFact,
  outcomeOccurredAt,
} from "../../../tests/wave-two-outcome-fact-test-support";

const timing = { occurredAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:01.000Z" };
const audit = { performedByUserId: "usr_bootstrap", forAccountId: "acc_bootstrap" } as const;

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
