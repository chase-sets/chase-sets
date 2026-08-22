import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type StoredEvent } from "@chase-sets/event-core/storage";
import {
  ORDER_CLEANUP_AUTHORITY_ORDER_MAX_EVENTS,
  ORDER_CLEANUP_AUTHORITY_SCHEMA_VERSION,
  observeBuyerOrderCleanupAuthority,
  observeEvidenceWindowSourceCleanupAuthority,
  observeOrderCleanupAuthority,
  type OrderCleanupAuthorityObservation,
  type OrderCleanupAuthorityReport,
} from "./cleanup-authority";
import {
  BUYER_ACCOUNT_ID,
  ORDER_ID,
  OTHER_TENANT_ID,
  SELLER_ACCOUNT_ID,
  TEST_TENANT_ID,
  WINDOW_OPENED_AT,
  buildStoredEvents,
  confirmedReservation,
  createRecordingStreamReader,
  createStubInventoryAuthority,
  holdAuthority,
  orderCreatedPayload,
  rejectedReservation,
  resetGlobalPositions,
  type EventSpec,
  type StubInventoryAuthorityConfig,
} from "../../../tests/test-support/cleanup-authority";

const ORDER_STREAM_ID = `ordering.order-${ORDER_ID}`;
const CREATED_AT = "2026-08-02T00:00:00.000Z";
const CANCELLED_AT = "2026-08-03T00:00:00.000Z";
const RELEASED_AT = "2026-08-03T00:00:05.000Z";

function created(overrides: Parameters<typeof orderCreatedPayload>[0] = {}): EventSpec {
  return { eventType: "ordering.order.created", payload: orderCreatedPayload(overrides), recordedAt: CREATED_AT };
}

function confirmed(
  overrides: Readonly<{
    reservationRequestId?: string;
    holdId?: string;
    inventoryItemId?: string;
    quantity?: number;
  }> = {},
): EventSpec {
  return {
    eventType: "ordering.order.reservation-confirmed",
    payload: {
      orderId: ORDER_ID,
      reservationRequestId: overrides.reservationRequestId ?? "rsv_1",
      inventoryItemId: overrides.inventoryItemId ?? "inv_1",
      sellerAccountId: SELLER_ACCOUNT_ID,
      quantity: overrides.quantity ?? 1,
      holdId: overrides.holdId ?? "hld_1",
      confirmedAt: CREATED_AT,
    },
    recordedAt: CREATED_AT,
  };
}

function rejected(reservationRequestId = "rsv_1"): EventSpec {
  return {
    eventType: "ordering.order.reservation-rejected",
    payload: { orderId: ORDER_ID, reservationRequestId, rejectedAt: CREATED_AT, reason: "inventory-unavailable" },
    recordedAt: CREATED_AT,
  };
}

function pendingPayment(): EventSpec {
  return {
    eventType: "ordering.order.pending-payment-recorded",
    payload: {
      orderId: ORDER_ID,
      pendingPaymentAt: CREATED_AT,
      paymentDeadlineAt: "2026-08-05T00:00:00.000Z",
      paymentDeadlinePolicy: "standard",
    },
    recordedAt: CREATED_AT,
  };
}

function readyForFulfillment(): EventSpec {
  return {
    eventType: "ordering.order.ready-for-fulfillment-recorded",
    payload: { orderId: ORDER_ID, readyForFulfillmentAt: CREATED_AT },
    recordedAt: CREATED_AT,
  };
}

function cancelled(
  overrides: Readonly<{
    reason?: string;
    buyerAccountId?: string | null | undefined;
    statusBeforeCancellation?: string | null | undefined;
    recordedAt?: string;
    omitBuyerAccountId?: boolean;
    omitStatusBefore?: boolean;
  }> = {},
): EventSpec {
  const payload: Record<string, unknown> = {
    orderId: ORDER_ID,
    cancelledAt: CANCELLED_AT,
    reason: overrides.reason ?? "buyer-cancelled",
    buyerEmail: null,
    reservationRequests: [],
  };
  if (!overrides.omitBuyerAccountId) {
    payload.buyerAccountId = overrides.buyerAccountId === undefined ? BUYER_ACCOUNT_ID : overrides.buyerAccountId;
  }
  if (!overrides.omitStatusBefore) {
    payload.statusBeforeCancellation =
      overrides.statusBeforeCancellation === undefined ? "pending-reservation" : overrides.statusBeforeCancellation;
  }
  return {
    eventType: "ordering.order.cancelled",
    payload,
    recordedAt: overrides.recordedAt ?? CANCELLED_AT,
  };
}

function orderReleased(reservationRequestId = "rsv_1", holdId = "hld_1"): EventSpec {
  return {
    eventType: "ordering.order.reservation-released",
    payload: { orderId: ORDER_ID, reservationRequestId, holdId, releasedAt: RELEASED_AT },
    recordedAt: RELEASED_AT,
  };
}

function observe(
  specs: readonly EventSpec[],
  inventory: StubInventoryAuthorityConfig,
  overrides: Readonly<{ orderId?: string; windowOpenedAt?: string; buyerAccountId?: string }> = {},
) {
  const reader = createRecordingStreamReader({ [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, specs) });
  const port = createStubInventoryAuthority(inventory);
  return {
    reader,
    port,
    run: () =>
      observeBuyerOrderCleanupAuthority(
        { eventStore: reader, inventory: port },
        {
          orderId: overrides.orderId ?? ORDER_ID,
          windowOpenedAt: overrides.windowOpenedAt ?? WINDOW_OPENED_AT,
          buyerAccountId: overrides.buyerAccountId ?? BUYER_ACCOUNT_ID,
          tenantId: TEST_TENANT_ID,
        },
      ),
  };
}

function expectObserved(observation: OrderCleanupAuthorityObservation): OrderCleanupAuthorityReport {
  expect(observation.outcome).toBe("observed");
  if (observation.outcome !== "observed") {
    throw new Error("expected an observation");
  }
  return observation.report;
}

/** Cancelled-from-pending-reservation history with one confirmed declaration. */
const CANCELLED_WITH_CONFIRMATION: readonly EventSpec[] = [
  created(),
  confirmed(),
  pendingPayment(),
  cancelled({ statusBeforeCancellation: "pending-payment" }),
];

/**
 * F1: Ordering cancelled from `pending-reservation` and never recorded the
 * confirmation Inventory committed atomically with the Hold.
 */
const CANCELLED_WITHOUT_ORDER_TERMINAL: readonly EventSpec[] = [created(), cancelled()];

const ACTIVE_HOLD_AUTHORITY: StubInventoryAuthorityConfig = {
  reservations: { rsv_1: confirmedReservation() },
  holds: { hld_1: holdAuthority({ status: "active" }) },
  lookup: { kind: "lookup", holdIds: ["hld_1"] },
};

const RELEASED_HOLD_AUTHORITY: StubInventoryAuthorityConfig = {
  reservations: {
    rsv_1: confirmedReservation({
      released: {
        reservationRequestId: "rsv_1",
        orderId: ORDER_ID,
        sellerAccountId: SELLER_ACCOUNT_ID,
        holdId: "hld_1",
        releasedAt: RELEASED_AT,
        releaseReason: "order-cancelled",
      },
      streamVersion: 2,
    }),
  },
  holds: {
    hld_1: holdAuthority({
      status: "released",
      releaseReason: "order-cancelled",
      releasedRecordedAt: RELEASED_AT,
      streamVersion: 2,
    }),
  },
  lookup: { kind: "lookup", holdIds: ["hld_1"] },
};

beforeEach(() => {
  resetGlobalPositions();
});

describe("cleanup-authority-single-fold", () => {
  it("reads only the Order stream and no projection, readiness marker, or write path", async () => {
    const { reader, port, run } = observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY);
    const report = expectObserved(await run());

    expect(report.state).toBe("cleanup-complete");
    expect(new Set(reader.streamIds())).toEqual(new Set([ORDER_STREAM_ID]));
    // The fold has no database handle at all: its only collaborators are a
    // stream reader and the Inventory authority port.
    expect(port.lookupCalls).toEqual([ORDER_ID]);
    expect(port.reservationCalls).toEqual(["rsv_1"]);
    expect(port.holdCalls).toEqual(["hld_1"]);
  });

  it("routes both adapters through one fold rather than a second implementation", async () => {
    const reader = createRecordingStreamReader({
      [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, CANCELLED_WITH_CONFIRMATION),
    });
    const port = createStubInventoryAuthority(RELEASED_HOLD_AUTHORITY);
    const deps = { eventStore: reader, inventory: port };

    const buyer = expectObserved(
      await observeBuyerOrderCleanupAuthority(deps, {
        orderId: ORDER_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        buyerAccountId: BUYER_ACCOUNT_ID,
        tenantId: TEST_TENANT_ID,
      }),
    );

    const source = await observeEvidenceWindowSourceCleanupAuthority(deps, {
      source: { sourceType: "cart-checkout", sourceReferenceId: "chk_1" },
      buyerAccountId: BUYER_ACCOUNT_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      orderIds: [ORDER_ID],
      tenantId: TEST_TENANT_ID,
    });

    expect(source.outcome).toBe("observed");
    if (source.outcome !== "observed") {
      throw new Error("expected observations");
    }
    expect(expectObserved(source.observations[0]!.observation)).toEqual(buyer);
    // One Order stream read per observation -- never two folds of one history.
    expect(reader.streamIds().filter((streamId) => streamId === ORDER_STREAM_ID)).toHaveLength(2);
  });

  it("never reports the Option-A-only cleanup-indeterminate state", async () => {
    const { run } = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, { reservations: {} });
    const observation = await run();

    expect(observation.outcome).toBe("conflict");
    expect(JSON.stringify(observation)).not.toContain("cleanup-indeterminate");
  });
});

describe("cleanup-authority-complete-read-bounds", () => {
  it("reads the Order stream with only streamId and maxEvents, never a pageSize", async () => {
    const { reader, run } = observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY);
    await run();

    expect(reader.calls.length).toBeGreaterThan(0);
    for (const call of reader.calls) {
      expect(Object.keys(call).sort()).toEqual(["fromVersion", "limit", "streamId"]);
      expect(call.limit).toBe(EVENT_STORE_READ_PAGE_SIZE_MAX);
      expect(call).not.toHaveProperty("pageSize");
    }
  });

  it("accepts an exact-bound 500-event Order history and rejects 501", async () => {
    const filler = (count: number): EventSpec[] =>
      Array.from({ length: count }, () => ({
        eventType: "ordering.order.line-item-amounts-published",
        payload: { orderId: ORDER_ID, lineItems: [] },
        recordedAt: CREATED_AT,
      }));

    // A 500-event history built from repeated additive facts would violate the
    // literal history rules, so the bound is exercised on the read itself.
    const atBound = buildStoredEvents(ORDER_STREAM_ID, [
      created(),
      ...filler(ORDER_CLEANUP_AUTHORITY_ORDER_MAX_EVENTS - 1),
    ]);
    const overBound = buildStoredEvents(ORDER_STREAM_ID, [
      created(),
      ...filler(ORDER_CLEANUP_AUTHORITY_ORDER_MAX_EVENTS),
    ]);
    expect(atBound).toHaveLength(500);
    expect(overBound).toHaveLength(501);

    const readAtBound = createRecordingStreamReader({ [ORDER_STREAM_ID]: atBound });
    const readOverBound = createRecordingStreamReader({ [ORDER_STREAM_ID]: overBound });
    const port = createStubInventoryAuthority({});
    const input = {
      orderId: ORDER_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      buyerAccountId: BUYER_ACCOUNT_ID,
      tenantId: TEST_TENANT_ID,
    };

    const atBoundOutcome = await observeBuyerOrderCleanupAuthority({ eventStore: readAtBound, inventory: port }, input);
    const overBoundOutcome = await observeBuyerOrderCleanupAuthority(
      { eventStore: readOverBound, inventory: port },
      input,
    );

    // The exact-bound history is read completely and then fails on its own
    // literal-history rules, not on the read bound.
    expect(atBoundOutcome).toEqual({ outcome: "conflict", reason: "order-line-amounts-out-of-order" });
    // One event past the bound never reaches the fold at all.
    expect(overBoundOutcome).toEqual({ outcome: "conflict", reason: "order-stream-unreadable" });
  });
});

describe("cleanup-authority-history-validation", () => {
  it("requires exactly one creation at version 1 matching the Order, window, and buyer", async () => {
    const missing = observe([], ACTIVE_HOLD_AUTHORITY);
    expect(await missing.run()).toEqual({ outcome: "not-found" });

    const foreignBuyer = observe([created({ buyerAccountId: "acc_other" }), cancelled()], ACTIVE_HOLD_AUTHORITY);
    expect(await foreignBuyer.run()).toEqual({ outcome: "not-found" });

    const wrongOrder = observe([created({ orderId: "ord_other" })], ACTIVE_HOLD_AUTHORITY);
    expect(await wrongOrder.run()).toEqual({ outcome: "conflict", reason: "order-identity-mismatch" });

    const notCreationFirst = observe([confirmed(), created()], ACTIVE_HOLD_AUTHORITY);
    expect(await notCreationFirst.run()).toEqual({ outcome: "conflict", reason: "order-creation-missing" });

    const repeatedCreation = observe([created(), created()], ACTIVE_HOLD_AUTHORITY);
    expect(await repeatedCreation.run()).toEqual({ outcome: "conflict", reason: "order-creation-repeated" });

    const beforeWindow = observe([created(), cancelled()], ACTIVE_HOLD_AUTHORITY, {
      windowOpenedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(await beforeWindow.run()).toEqual({ outcome: "conflict", reason: "order-created-before-window" });
  });

  it("accepts a missing line-amount fact but rejects a duplicate, late, or mismatched one", async () => {
    const lineAmounts: EventSpec = {
      eventType: "ordering.order.line-item-amounts-published",
      payload: { orderId: ORDER_ID, lineItems: [{ lineId: "oli_1", amount: "20.00" }] },
      recordedAt: CREATED_AT,
    };

    const withFact = observe([created(), lineAmounts, confirmed(), cancelled()], RELEASED_HOLD_AUTHORITY);
    expect(expectObserved(await withFact.run()).state).toBe("cleanup-complete");

    const withoutFact = observe([created(), confirmed(), cancelled()], RELEASED_HOLD_AUTHORITY);
    expect(expectObserved(await withoutFact.run()).state).toBe("cleanup-complete");

    const late = observe([created(), confirmed(), lineAmounts, cancelled()], RELEASED_HOLD_AUTHORITY);
    expect(await late.run()).toEqual({ outcome: "conflict", reason: "order-line-amounts-out-of-order" });

    const duplicate = observe([created(), lineAmounts, lineAmounts, cancelled()], RELEASED_HOLD_AUTHORITY);
    expect(await duplicate.run()).toEqual({ outcome: "conflict", reason: "order-line-amounts-out-of-order" });

    const mismatched = observe(
      [
        created(),
        {
          eventType: "ordering.order.line-item-amounts-published",
          payload: { orderId: ORDER_ID, lineItems: [{ lineId: "oli_unknown", amount: "20.00" }] },
          recordedAt: CREATED_AT,
        },
        cancelled(),
      ],
      RELEASED_HOLD_AUTHORITY,
    );
    expect(await mismatched.run()).toEqual({ outcome: "conflict", reason: "order-line-amounts-mismatch" });
  });

  it("rejects duplicate declarations, unknown requests, repeated terminals, and reused Holds", async () => {
    const duplicateDeclaration = observe(
      [
        created({
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: SELLER_ACCOUNT_ID,
              quantity: 1,
            },
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_2",
              sellerAccountId: SELLER_ACCOUNT_ID,
              quantity: 1,
            },
          ],
        }),
      ],
      ACTIVE_HOLD_AUTHORITY,
    );
    expect(await duplicateDeclaration.run()).toEqual({
      outcome: "conflict",
      reason: "order-reservation-request-duplicate",
    });

    const unknownRequest = observe(
      [created(), confirmed({ reservationRequestId: "rsv_unknown" })],
      ACTIVE_HOLD_AUTHORITY,
    );
    expect(await unknownRequest.run()).toEqual({
      outcome: "conflict",
      reason: "order-reservation-confirmation-unknown-request",
    });

    const bothOutcomes = observe([created(), confirmed(), rejected()], ACTIVE_HOLD_AUTHORITY);
    expect(await bothOutcomes.run()).toEqual({ outcome: "conflict", reason: "order-reservation-terminal-repeated" });

    const reusedHold = observe(
      [
        created({
          reservationRequests: [
            {
              reservationRequestId: "rsv_1",
              inventoryItemId: "inv_1",
              sellerAccountId: SELLER_ACCOUNT_ID,
              quantity: 1,
            },
            {
              reservationRequestId: "rsv_2",
              inventoryItemId: "inv_2",
              sellerAccountId: SELLER_ACCOUNT_ID,
              quantity: 1,
            },
          ],
        }),
        confirmed({ reservationRequestId: "rsv_1", holdId: "hld_1" }),
        confirmed({ reservationRequestId: "rsv_2", holdId: "hld_1", inventoryItemId: "inv_2" }),
      ],
      ACTIVE_HOLD_AUTHORITY,
    );
    expect(await reusedHold.run()).toEqual({ outcome: "conflict", reason: "order-reservation-hold-reused" });

    const mismatchedConfirmation = observe([created(), confirmed({ quantity: 9 })], ACTIVE_HOLD_AUTHORITY);
    expect(await mismatchedConfirmation.run()).toEqual({
      outcome: "conflict",
      reason: "order-reservation-confirmation-mismatch",
    });
  });

  it("rejects an out-of-order pending payment, capture, cancellation, or Ordering release", async () => {
    const earlyPendingPayment = observe([created(), pendingPayment()], ACTIVE_HOLD_AUTHORITY);
    expect(await earlyPendingPayment.run()).toEqual({
      outcome: "conflict",
      reason: "order-pending-payment-before-reservation-outcomes",
    });

    const captureWithoutPayment = observe([created(), confirmed(), readyForFulfillment()], ACTIVE_HOLD_AUTHORITY);
    expect(await captureWithoutPayment.run()).toEqual({ outcome: "conflict", reason: "order-capture-out-of-order" });

    const repeatedCancellation = observe([created(), cancelled(), cancelled()], ACTIVE_HOLD_AUTHORITY);
    expect(await repeatedCancellation.run()).toEqual({ outcome: "conflict", reason: "order-cancellation-repeated" });

    const releaseBeforeCancellation = observe([created(), confirmed(), orderReleased()], ACTIVE_HOLD_AUTHORITY);
    expect(await releaseBeforeCancellation.run()).toEqual({
      outcome: "conflict",
      reason: "order-release-before-cancellation",
    });

    const releaseOfUnconfirmedRequest = observe(
      [created(), rejected(), cancelled(), orderReleased()],
      ACTIVE_HOLD_AUTHORITY,
    );
    expect(await releaseOfUnconfirmedRequest.run()).toEqual({
      outcome: "conflict",
      reason: "order-release-unconfirmed-request",
    });

    const unexpectedEvent = observe(
      [created(), { eventType: "ordering.order.invented", payload: { orderId: ORDER_ID } }],
      ACTIVE_HOLD_AUTHORITY,
    );
    expect(await unexpectedEvent.run()).toEqual({ outcome: "conflict", reason: "order-unexpected-event" });
  });

  it("accepts a v2 release that omits item and quantity and rejects every field it does carry", async () => {
    const validRelease = RELEASED_HOLD_AUTHORITY.reservations!.rsv_1;
    if (validRelease.kind !== "confirmed" || validRelease.released === null) {
      throw new Error("expected a confirmed reservation with a release");
    }
    // The v2 payload carries request, order, seller, Hold, instant, and
    // reason -- and deliberately not item or quantity.
    expect(Object.keys(validRelease.released).sort()).toEqual([
      "holdId",
      "orderId",
      "releaseReason",
      "releasedAt",
      "reservationRequestId",
      "sellerAccountId",
    ]);

    const valid = observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY);
    expect(expectObserved(await valid.run()).state).toBe("cleanup-complete");

    const mutations: readonly Readonly<{ field: string; released: typeof validRelease.released; reason: string }>[] = [
      {
        field: "reservationRequestId",
        released: { ...validRelease.released, reservationRequestId: "rsv_other" },
        reason: "inventory-reservation-release-mismatch",
      },
      {
        field: "orderId",
        released: { ...validRelease.released, orderId: "ord_other" },
        reason: "inventory-reservation-release-mismatch",
      },
      {
        field: "sellerAccountId",
        released: { ...validRelease.released, sellerAccountId: "acc_other" },
        reason: "inventory-reservation-release-mismatch",
      },
      {
        field: "holdId",
        released: { ...validRelease.released, holdId: "hld_other" },
        reason: "inventory-reservation-release-mismatch",
      },
      {
        field: "releaseReason",
        released: { ...validRelease.released, releaseReason: "hold-collision" },
        reason: "inventory-reservation-release-reason-mismatch",
      },
    ];

    for (const mutation of mutations) {
      const mutated = observe(CANCELLED_WITH_CONFIRMATION, {
        ...RELEASED_HOLD_AUTHORITY,
        reservations: { rsv_1: confirmedReservation({ released: mutation.released, streamVersion: 2 }) },
      });
      expect({ field: mutation.field, ...(await mutated.run()) }).toEqual({
        field: mutation.field,
        outcome: "conflict",
        reason: mutation.reason,
      });
    }
  });

  it("rejects Inventory authority that disagrees with the declaration or the Order terminal", async () => {
    const identityMismatches: readonly Readonly<{ label: string; config: StubInventoryAuthorityConfig }>[] = [
      { label: "orderId", config: { reservations: { rsv_1: confirmedReservation({ orderId: "ord_other" }) } } },
      { label: "seller", config: { reservations: { rsv_1: confirmedReservation({ sellerAccountId: "acc_other" }) } } },
      { label: "item", config: { reservations: { rsv_1: confirmedReservation({ inventoryItemId: "inv_9" }) } } },
      { label: "quantity", config: { reservations: { rsv_1: confirmedReservation({ quantity: 4 }) } } },
    ];

    for (const mismatch of identityMismatches) {
      const mutated = observe(CANCELLED_WITH_CONFIRMATION, mismatch.config);
      expect({ label: mismatch.label, ...(await mutated.run()) }).toEqual({
        label: mismatch.label,
        outcome: "conflict",
        reason: "inventory-reservation-authority-mismatch",
      });
    }

    const disagreesWithOrder = observe(CANCELLED_WITH_CONFIRMATION, { reservations: { rsv_1: rejectedReservation() } });
    expect(await disagreesWithOrder.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-authority-disagrees-with-order",
    });

    const differentHold = observe(CANCELLED_WITH_CONFIRMATION, {
      reservations: { rsv_1: confirmedReservation({ holdId: "hld_other" }) },
      holds: { hld_other: holdAuthority({ holdId: "hld_other" }) },
      lookup: { kind: "lookup", holdIds: ["hld_other"] },
    });
    expect(await differentHold.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-authority-disagrees-with-order",
    });

    const holdIdentityMismatch = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      holds: { hld_1: holdAuthority({ sourceReservationRequestId: "rsv_other" }) },
    });
    expect(await holdIdentityMismatch.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-hold-identity-mismatch",
    });
  });
});

describe("cleanup-authority-historical-cancellation", () => {
  it("derives an omitted buyer account and pre-cancellation status", async () => {
    const omitted = observe(
      [created(), confirmed(), pendingPayment(), cancelled({ omitBuyerAccountId: true, omitStatusBefore: true })],
      RELEASED_HOLD_AUTHORITY,
    );
    const report = expectObserved(await omitted.run());

    expect(report.state).toBe("cleanup-complete");
    // Derived from creation and the immediately pre-cancellation fold.
    expect(report.cancellationStatusBefore).toBe("pending-payment");
  });

  it("accepts an explicit null for either historical field", async () => {
    const nulled = observe(
      [created(), confirmed(), cancelled({ buyerAccountId: null, statusBeforeCancellation: null })],
      RELEASED_HOLD_AUTHORITY,
    );
    const report = expectObserved(await nulled.run());

    expect(report.state).toBe("cleanup-complete");
    expect(report.cancellationStatusBefore).toBe("pending-reservation");
  });

  it("rejects a present value that disagrees with the derived one", async () => {
    const buyerConflict = observe(
      [created(), confirmed(), cancelled({ buyerAccountId: "acc_other" })],
      RELEASED_HOLD_AUTHORITY,
    );
    expect(await buyerConflict.run()).toEqual({ outcome: "conflict", reason: "order-cancellation-buyer-mismatch" });

    const statusConflict = observe(
      [created(), confirmed(), pendingPayment(), cancelled({ statusBeforeCancellation: "pending-reservation" })],
      RELEASED_HOLD_AUTHORITY,
    );
    expect(await statusConflict.run()).toEqual({ outcome: "conflict", reason: "order-cancellation-status-mismatch" });
  });
});

describe("cleanup-authority-orphan-hold-race", () => {
  it("refuses to complete before Inventory has handled creation", async () => {
    const beforeInventory = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, { reservations: {} });
    expect(await beforeInventory.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-authority-incomplete",
    });
  });

  it("may complete with zero Holds once Inventory has rejected the request", async () => {
    const afterRejection = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, {
      reservations: { rsv_1: rejectedReservation() },
      lookup: { kind: "lookup", holdIds: [] },
    });
    const report = expectObserved(await afterRejection.run());

    expect(report.state).toBe("cleanup-complete");
    expect(report.holdCounts).toEqual({ total: 0, active: 0, released: 0, consumed: 0, expired: 0 });
    expect(report.holdStreamVersions).toEqual([]);
  });

  it("exposes the atomically created Hold the Order never recorded", async () => {
    const orphan = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, ACTIVE_HOLD_AUTHORITY);
    const report = expectObserved(await orphan.run());

    expect(report.state).toBe("cancelled-release-pending");
    expect(report.retryable).toBe(true);
    expect(report.holdCounts).toEqual({ total: 1, active: 1, released: 0, consumed: 0, expired: 0 });
  });

  it("completes only after the Hold is causally released", async () => {
    const released = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, RELEASED_HOLD_AUTHORITY);
    const report = expectObserved(await released.run());

    expect(report.state).toBe("cleanup-complete");
    expect(report.holdCounts).toEqual({ total: 1, active: 1 - 1, released: 1, consumed: 0, expired: 0 });
  });

  it("restores the false completion when the reservation prerequisite is deleted", async () => {
    // Mutant: skip the reservation-authority requirement and decide only from
    // the Order's own (empty) terminal set plus an empty lookup. The mutant
    // reports cleanup-complete for the exact history in which #7199 F1 leaves
    // a live Hold, which is the defect this AC exists to prevent.
    const mutantReport = mutantCompleteWithoutReservationAuthority();
    expect(mutantReport).toBe("cleanup-complete");

    const guarded = observe(CANCELLED_WITHOUT_ORDER_TERMINAL, { lookup: { kind: "lookup", holdIds: [] } });
    expect(await guarded.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-authority-incomplete",
    });
  });
});

/**
 * Reproduces the Option-A-shaped fold this issue replaces: decide from
 * Order-recorded terminals alone. It is a local model, never production code.
 */
function mutantCompleteWithoutReservationAuthority(): string {
  const orderRecordedConfirmations: readonly string[] = [];
  const lookupHoldIds: readonly string[] = [];
  return orderRecordedConfirmations.length === lookupHoldIds.length ? "cleanup-complete" : "cancelled-release-pending";
}

describe("cleanup-authority-state-table", () => {
  it("reports live-cancelable for an uncancelled pending Order without reading Inventory", async () => {
    const pendingReservation = observe([created()], ACTIVE_HOLD_AUTHORITY);
    const pendingReservationReport = expectObserved(await pendingReservation.run());
    expect(pendingReservationReport.state).toBe("live-cancelable");
    expect(pendingReservationReport.retryable).toBe(true);
    expect(pendingReservationReport.orderStatus).toBe("pending-reservation");
    expect(pendingReservation.port.reservationCalls).toEqual([]);
    expect(pendingReservation.port.lookupCalls).toEqual([]);

    const pendingPaymentOrder = observe([created(), confirmed(), pendingPayment()], ACTIVE_HOLD_AUTHORITY);
    const pendingPaymentReport = expectObserved(await pendingPaymentOrder.run());
    expect(pendingPaymentReport.state).toBe("live-cancelable");
    expect(pendingPaymentReport.orderStatus).toBe("pending-payment");
  });

  it("reports captured-remedy-required for any history that reached fulfillment readiness", async () => {
    const captured = observe([created(), confirmed(), pendingPayment(), readyForFulfillment()], ACTIVE_HOLD_AUTHORITY);
    const capturedReport = expectObserved(await captured.run());
    expect(capturedReport.state).toBe("captured-remedy-required");
    expect(capturedReport.retryable).toBe(false);

    const capturedThenCancelled = observe(
      [
        created(),
        confirmed(),
        pendingPayment(),
        readyForFulfillment(),
        cancelled({ statusBeforeCancellation: "ready-for-fulfillment" }),
      ],
      ACTIVE_HOLD_AUTHORITY,
    );
    const capturedThenCancelledReport = expectObserved(await capturedThenCancelled.run());
    expect(capturedThenCancelledReport.state).toBe("captured-remedy-required");
    expect(capturedThenCancelledReport.orderStatus).toBe("cancelled");
    expect(capturedThenCancelled.port.lookupCalls).toEqual([]);
  });

  it("reports cancelled-release-pending while a validated Hold is still active", async () => {
    const active = observe(CANCELLED_WITH_CONFIRMATION, ACTIVE_HOLD_AUTHORITY);
    const report = expectObserved(await active.run());
    expect(report.state).toBe("cancelled-release-pending");
    expect(report.retryable).toBe(true);
  });

  it("reports cancelled-cleanup-blocked for a consumed, expired, wrong-reason, or pre-cancellation terminal", async () => {
    const blockedCases: readonly Readonly<{ label: string; config: StubInventoryAuthorityConfig }>[] = [
      {
        label: "consumed",
        config: { ...ACTIVE_HOLD_AUTHORITY, holds: { hld_1: holdAuthority({ status: "consumed" }) } },
      },
      {
        label: "expired",
        config: { ...ACTIVE_HOLD_AUTHORITY, holds: { hld_1: holdAuthority({ status: "expired" }) } },
      },
      {
        label: "wrong-reason",
        config: {
          ...ACTIVE_HOLD_AUTHORITY,
          holds: {
            hld_1: holdAuthority({
              status: "released",
              releaseReason: "hold-collision",
              releasedRecordedAt: RELEASED_AT,
            }),
          },
        },
      },
      {
        label: "released-before-cancellation",
        config: {
          ...ACTIVE_HOLD_AUTHORITY,
          holds: {
            hld_1: holdAuthority({
              status: "released",
              releaseReason: "order-cancelled",
              releasedRecordedAt: "2026-08-02T12:00:00.000Z",
            }),
          },
        },
      },
    ];

    for (const blocked of blockedCases) {
      const observation = observe(CANCELLED_WITH_CONFIRMATION, blocked.config);
      const report = expectObserved(await observation.run());
      expect({ label: blocked.label, state: report.state, retryable: report.retryable }).toEqual({
        label: blocked.label,
        state: "cancelled-cleanup-blocked",
        retryable: false,
      });
    }
  });

  it("treats a hold-collision reservation release as an explicit rule-3 mismatch", async () => {
    // `honor-offline` hold-collision resolution releases both the Hold and the
    // reservation with reason `hold-collision`, outside the governed
    // cancellation mapping. Option B rule 3 makes that reservation authority a
    // mismatch: a conflict, never a discharge.
    const collision = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      reservations: {
        rsv_1: confirmedReservation({
          released: {
            reservationRequestId: "rsv_1",
            orderId: ORDER_ID,
            sellerAccountId: SELLER_ACCOUNT_ID,
            holdId: "hld_1",
            releasedAt: "2026-08-02T06:00:00.000Z",
            releaseReason: "hold-collision",
          },
          streamVersion: 2,
        }),
      },
    });
    expect(await collision.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-release-reason-mismatch",
    });
  });

  it("maps a payment-deadline cancellation to the payment-deadline release reason", async () => {
    const deadlineHistory = [
      created(),
      confirmed(),
      pendingPayment(),
      cancelled({ reason: "payment-deadline", statusBeforeCancellation: "pending-payment" }),
    ];

    const matching = observe(deadlineHistory, {
      reservations: {
        rsv_1: confirmedReservation({
          released: {
            reservationRequestId: "rsv_1",
            orderId: ORDER_ID,
            sellerAccountId: SELLER_ACCOUNT_ID,
            holdId: "hld_1",
            releasedAt: RELEASED_AT,
            releaseReason: "payment-deadline",
          },
          streamVersion: 2,
        }),
      },
      holds: {
        hld_1: holdAuthority({
          status: "released",
          releaseReason: "payment-deadline",
          releasedRecordedAt: RELEASED_AT,
          streamVersion: 2,
        }),
      },
      lookup: { kind: "lookup", holdIds: ["hld_1"] },
    });
    expect(expectObserved(await matching.run()).state).toBe("cleanup-complete");

    const wrongReason = observe(deadlineHistory, RELEASED_HOLD_AUTHORITY);
    expect(await wrongReason.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-reservation-release-reason-mismatch",
    });
  });

  it("refuses cleanup for a cancellation the contract does not cover", async () => {
    const notEligible = observe(
      [
        created(),
        confirmed(),
        pendingPayment(),
        readyForFulfillment(),
        cancelled({ statusBeforeCancellation: "ready-for-fulfillment" }),
      ],
      ACTIVE_HOLD_AUTHORITY,
    );
    // A cancellation from ready-for-fulfillment is captured, which outranks
    // cleanup eligibility entirely.
    expect(expectObserved(await notEligible.run()).state).toBe("captured-remedy-required");
  });

  it("emits only the five Option B states and the closed response shape", async () => {
    const report = expectObserved(await observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY).run());

    expect(report.schemaVersion).toBe(ORDER_CLEANUP_AUTHORITY_SCHEMA_VERSION);
    expect(Object.keys(report).sort()).toEqual([
      "cancellationStatusBefore",
      "holdCounts",
      "holdStreamVersions",
      "orderStatus",
      "orderStreamVersion",
      "retryable",
      "schemaVersion",
      "state",
    ]);
    expect(Object.keys(report.holdCounts).sort()).toEqual(["active", "consumed", "expired", "released", "total"]);
    expect(report.holdCounts.total).toBe(
      report.holdCounts.active + report.holdCounts.released + report.holdCounts.consumed + report.holdCounts.expired,
    );
    expect(report.holdStreamVersions).toHaveLength(report.holdCounts.total);
    expect(report.orderStreamVersion).toBe(CANCELLED_WITH_CONFIRMATION.length);
  });
});

describe("cleanup-authority-repeat-day-after", () => {
  const steadyStates: readonly Readonly<{ label: string; config: StubInventoryAuthorityConfig; state: string }>[] = [
    {
      label: "rejected",
      config: { reservations: { rsv_1: rejectedReservation() }, lookup: { kind: "lookup", holdIds: [] } },
      state: "cleanup-complete",
    },
    { label: "confirmed-active", config: ACTIVE_HOLD_AUTHORITY, state: "cancelled-release-pending" },
    { label: "released", config: RELEASED_HOLD_AUTHORITY, state: "cleanup-complete" },
  ];

  it("returns the same report on a repeat read the next day", async () => {
    for (const steady of steadyStates) {
      const history = steady.label === "rejected" ? CANCELLED_WITHOUT_ORDER_TERMINAL : CANCELLED_WITH_CONFIRMATION;
      const first = observe(history, steady.config);
      const firstReport = expectObserved(await first.run());
      const secondReport = expectObserved(await first.run());

      expect({ label: steady.label, state: firstReport.state }).toEqual({ label: steady.label, state: steady.state });
      expect(secondReport).toEqual(firstReport);
    }
  });

  it("keeps the window valid with no release-time age limit", async () => {
    const dayAfter = observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY, {
      windowOpenedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(expectObserved(await dayAfter.run()).state).toBe("cleanup-complete");
  });

  it("rejects a window instant that is not a strict RFC 3339 UTC Z instant", async () => {
    const invalidWindows = [
      "2026-08-01T00:00:00+00:00",
      "2026-08-01T00:00:00",
      "2026-08-01",
      "2026-08-01T00:00:00z",
      "not-an-instant",
      "",
    ];
    for (const windowOpenedAt of invalidWindows) {
      const observation = await observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY, { windowOpenedAt }).run();
      expect({ windowOpenedAt, ...observation }).toEqual({
        windowOpenedAt,
        outcome: "invalid-request",
        reason: "window-opened-at-invalid",
      });
    }
  });
});

describe("cleanup-authority-inventory-source-lookup", () => {
  it("requires exact set equality between the lookup and the confirmed Hold set", async () => {
    const mutants: readonly Readonly<{ label: string; holdIds: readonly string[]; reason: string }>[] = [
      { label: "extra", holdIds: ["hld_1", "hld_extra"], reason: "inventory-hold-lookup-set-mismatch" },
      { label: "missing", holdIds: [], reason: "inventory-hold-lookup-set-mismatch" },
      { label: "duplicate", holdIds: ["hld_1", "hld_1"], reason: "inventory-hold-lookup-duplicate" },
      { label: "mismatch", holdIds: ["hld_other"], reason: "inventory-hold-lookup-set-mismatch" },
    ];

    for (const mutant of mutants) {
      const observation = observe(CANCELLED_WITH_CONFIRMATION, {
        ...ACTIVE_HOLD_AUTHORITY,
        lookup: { kind: "lookup", holdIds: mutant.holdIds },
      });
      expect({ label: mutant.label, ...(await observation.run()) }).toEqual({
        label: mutant.label,
        outcome: "conflict",
        reason: mutant.reason,
      });
    }
  });

  it("is order-insensitive: a shuffled lookup yields the identical declaration-ordered report", async () => {
    const twoDeclarations = [
      created({
        reservationRequests: [
          { reservationRequestId: "rsv_1", inventoryItemId: "inv_1", sellerAccountId: SELLER_ACCOUNT_ID, quantity: 1 },
          { reservationRequestId: "rsv_2", inventoryItemId: "inv_2", sellerAccountId: SELLER_ACCOUNT_ID, quantity: 2 },
        ],
      }),
      cancelled(),
    ];
    const authority: StubInventoryAuthorityConfig = {
      reservations: {
        rsv_1: confirmedReservation({ holdId: "hld_1" }),
        rsv_2: confirmedReservation({
          reservationRequestId: "rsv_2",
          inventoryItemId: "inv_2",
          quantity: 2,
          holdId: "hld_2",
        }),
      },
      holds: {
        hld_1: holdAuthority({ streamVersion: 1 }),
        hld_2: holdAuthority({
          holdId: "hld_2",
          inventoryItemId: "inv_2",
          quantity: 2,
          sourceReservationRequestId: "rsv_2",
          streamVersion: 3,
        }),
      },
    };

    const ordered = observe(twoDeclarations, { ...authority, lookup: { kind: "lookup", holdIds: ["hld_1", "hld_2"] } });
    const shuffled = observe(twoDeclarations, {
      ...authority,
      lookup: { kind: "lookup", holdIds: ["hld_2", "hld_1"] },
    });

    const orderedReport = expectObserved(await ordered.run());
    expect(expectObserved(await shuffled.run())).toEqual(orderedReport);
    // Counts and versions follow Order declaration order, not lookup order.
    expect(orderedReport.holdStreamVersions).toEqual([1, 3]);
    expect(shuffled.port.holdCalls).toEqual(["hld_1", "hld_2"]);
  });

  it("treats an over-bound or otherwise unusable lookup as a conflict", async () => {
    const overBound = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      lookup: { kind: "unavailable", detail: "hold-lookup-over-bound" },
    });
    expect(await overBound.run()).toEqual({ outcome: "conflict", reason: "inventory-hold-lookup-incomplete" });
  });

  it("passes the exact request tenant to every Inventory authority call", async () => {
    const observation = observe(CANCELLED_WITH_CONFIRMATION, RELEASED_HOLD_AUTHORITY);
    await observation.run();
    expect(new Set(observation.port.tenantIds)).toEqual(new Set([TEST_TENANT_ID]));
  });

  it("rejects a Hold whose reported set membership is reused across declarations", async () => {
    const twoDeclarations = [
      created({
        reservationRequests: [
          { reservationRequestId: "rsv_1", inventoryItemId: "inv_1", sellerAccountId: SELLER_ACCOUNT_ID, quantity: 1 },
          { reservationRequestId: "rsv_2", inventoryItemId: "inv_2", sellerAccountId: SELLER_ACCOUNT_ID, quantity: 2 },
        ],
      }),
      cancelled(),
    ];
    const reused = observe(twoDeclarations, {
      reservations: {
        rsv_1: confirmedReservation({ holdId: "hld_1" }),
        rsv_2: confirmedReservation({
          reservationRequestId: "rsv_2",
          inventoryItemId: "inv_2",
          quantity: 2,
          holdId: "hld_1",
        }),
      },
      holds: { hld_1: holdAuthority() },
      lookup: { kind: "lookup", holdIds: ["hld_1"] },
    });
    expect(await reused.run()).toEqual({ outcome: "conflict", reason: "inventory-reservation-hold-reused" });
  });
});

describe("cleanup-authority-release-causality", () => {
  it("requires the Hold release to be recorded at or after the Order cancellation", async () => {
    const atCancellation = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      holds: {
        hld_1: holdAuthority({
          status: "released",
          releaseReason: "order-cancelled",
          releasedRecordedAt: CANCELLED_AT,
        }),
      },
    });
    expect(expectObserved(await atCancellation.run()).state).toBe("cleanup-complete");

    const beforeCancellation = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      holds: {
        hld_1: holdAuthority({
          status: "released",
          releaseReason: "order-cancelled",
          releasedRecordedAt: "2026-08-02T23:59:59.999Z",
        }),
      },
    });
    expect(expectObserved(await beforeCancellation.run()).state).toBe("cancelled-cleanup-blocked");
  });

  it("refuses a released Hold that carries no release instant", async () => {
    const missingInstant = observe(CANCELLED_WITH_CONFIRMATION, {
      ...ACTIVE_HOLD_AUTHORITY,
      holds: {
        hld_1: holdAuthority({ status: "released", releaseReason: "order-cancelled", releasedRecordedAt: null }),
      },
    });
    expect(await missingInstant.run()).toEqual({
      outcome: "conflict",
      reason: "inventory-hold-release-timing-missing",
    });
  });
});

describe("cleanup-authority-concurrent-append", () => {
  it("reports the conservative pending intermediate rather than completing early", async () => {
    const concurrent = observe(CANCELLED_WITH_CONFIRMATION, ACTIVE_HOLD_AUTHORITY);
    expect(expectObserved(await concurrent.run()).state).toBe("cancelled-release-pending");
  });

  it("converges to complete on the next read once the release lands", async () => {
    const reader = createRecordingStreamReader({
      [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, CANCELLED_WITH_CONFIRMATION),
    });
    const port = createStubInventoryAuthority({
      reservationSequence: {
        rsv_1: [
          confirmedReservation(),
          confirmedReservation({
            released: {
              reservationRequestId: "rsv_1",
              orderId: ORDER_ID,
              sellerAccountId: SELLER_ACCOUNT_ID,
              holdId: "hld_1",
              releasedAt: RELEASED_AT,
              releaseReason: "order-cancelled",
            },
            streamVersion: 2,
          }),
        ],
      },
      holdSequence: {
        hld_1: [
          holdAuthority({ status: "active" }),
          holdAuthority({
            status: "released",
            releaseReason: "order-cancelled",
            releasedRecordedAt: RELEASED_AT,
            streamVersion: 2,
          }),
        ],
      },
      lookup: { kind: "lookup", holdIds: ["hld_1"] },
    });
    const deps = { eventStore: reader, inventory: port };
    const input = {
      orderId: ORDER_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      buyerAccountId: BUYER_ACCOUNT_ID,
      tenantId: TEST_TENANT_ID,
    };

    expect(expectObserved(await observeBuyerOrderCleanupAuthority(deps, input)).state).toBe(
      "cancelled-release-pending",
    );
    expect(expectObserved(await observeBuyerOrderCleanupAuthority(deps, input)).state).toBe("cleanup-complete");
  });

  it("poisons a later conflicting append into a conflict on the next read", async () => {
    const reader = createRecordingStreamReader({
      [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, CANCELLED_WITH_CONFIRMATION),
    });
    const port = createStubInventoryAuthority({
      reservations: { rsv_1: confirmedReservation() },
      holdSequence: {
        hld_1: [
          holdAuthority({ status: "active" }),
          { kind: "unavailable", holdId: "hld_1", detail: "hold-event-after-terminal" },
        ],
      },
      lookup: { kind: "lookup", holdIds: ["hld_1"] },
    });
    const deps = { eventStore: reader, inventory: port };
    const input = {
      orderId: ORDER_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      buyerAccountId: BUYER_ACCOUNT_ID,
      tenantId: TEST_TENANT_ID,
    };

    expect(expectObserved(await observeBuyerOrderCleanupAuthority(deps, input)).state).toBe(
      "cancelled-release-pending",
    );
    expect(await observeBuyerOrderCleanupAuthority(deps, input)).toEqual({
      outcome: "conflict",
      reason: "inventory-hold-authority-incomplete",
    });
  });

  it("never writes: the fold's only collaborators expose reads", async () => {
    const reader = createRecordingStreamReader({
      [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, CANCELLED_WITH_CONFIRMATION),
    });
    const port = createStubInventoryAuthority(RELEASED_HOLD_AUTHORITY);
    await observeOrderCleanupAuthority(
      { eventStore: reader, inventory: port },
      {
        orderId: ORDER_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        expectedBuyerAccountId: BUYER_ACCOUNT_ID,
        expectedSource: null,
        tenantId: TEST_TENANT_ID,
      },
    );

    expect(Object.keys(reader).sort()).toEqual(["calls", "readStream", "streamIds"]);
    expect(Object.keys(port).sort()).toEqual([
      "holdCalls",
      "lookupCalls",
      "lookupOrderHoldIds",
      "readHoldAuthority",
      "readReservationAuthority",
      "reservationCalls",
      "tenantIds",
    ]);
  });
});

describe("cleanup-authority-source-membership", () => {
  const deps = () => {
    const reader = createRecordingStreamReader({
      [ORDER_STREAM_ID]: buildStoredEvents(ORDER_STREAM_ID, CANCELLED_WITH_CONFIRMATION),
    });
    return { eventStore: reader, inventory: createStubInventoryAuthority(RELEASED_HOLD_AUTHORITY) };
  };

  const source = { sourceType: "cart-checkout", sourceReferenceId: "chk_1" } as const;

  it("rejects empty membership rather than reporting success", async () => {
    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source,
        buyerAccountId: BUYER_ACCOUNT_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: [],
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-membership-empty" });
  });

  it("rejects duplicate, malformed, and over-bound membership", async () => {
    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source,
        buyerAccountId: BUYER_ACCOUNT_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: [ORDER_ID, ORDER_ID],
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-membership-duplicate" });

    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source,
        buyerAccountId: BUYER_ACCOUNT_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: [" "],
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-membership-malformed" });

    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source,
        buyerAccountId: BUYER_ACCOUNT_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: Array.from({ length: 65 }, (_unused, index) => `ord_${index}`),
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-membership-over-bound" });
  });

  it("verifies the source identity on every creation event and preserves claim order", async () => {
    const mismatched = await observeEvidenceWindowSourceCleanupAuthority(deps(), {
      source: { sourceType: "offer-acceptance", sourceReferenceId: "off_1" },
      buyerAccountId: BUYER_ACCOUNT_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      orderIds: [ORDER_ID],
      tenantId: TEST_TENANT_ID,
    });
    expect(mismatched.outcome).toBe("observed");
    if (mismatched.outcome !== "observed") {
      throw new Error("expected observations");
    }
    expect(mismatched.observations[0]!.observation).toEqual({
      outcome: "conflict",
      reason: "order-source-identity-mismatch",
    });

    const missingStream = await observeEvidenceWindowSourceCleanupAuthority(deps(), {
      source,
      buyerAccountId: BUYER_ACCOUNT_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      orderIds: ["ord_missing", ORDER_ID],
      tenantId: TEST_TENANT_ID,
    });
    expect(missingStream.outcome).toBe("observed");
    if (missingStream.outcome !== "observed") {
      throw new Error("expected observations");
    }
    // Membership order is the durable source claim's order, and a missing
    // Order is a 404-shaped observation -- never a discharge.
    expect(missingStream.observations.map((entry) => entry.orderId)).toEqual(["ord_missing", ORDER_ID]);
    expect(missingStream.observations[0]!.observation).toEqual({ outcome: "not-found" });
    expect(expectObserved(missingStream.observations[1]!.observation).state).toBe("cleanup-complete");
  });

  it("rejects an invalid source identity or buyer", async () => {
    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source: { sourceType: "cart-checkout", sourceReferenceId: "  " },
        buyerAccountId: BUYER_ACCOUNT_ID,
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: [ORDER_ID],
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-identity-invalid" });

    expect(
      await observeEvidenceWindowSourceCleanupAuthority(deps(), {
        source,
        buyerAccountId: "",
        windowOpenedAt: WINDOW_OPENED_AT,
        orderIds: [ORDER_ID],
        tenantId: TEST_TENANT_ID,
      }),
    ).toEqual({ outcome: "invalid-request", reason: "source-buyer-required" });
  });
});

describe("cleanup-authority request validation", () => {
  it("rejects a missing Order id, buyer, or tenant before any read", async () => {
    const reader = createRecordingStreamReader({});
    const port = createStubInventoryAuthority({});
    const deps = { eventStore: reader, inventory: port };
    const base = {
      orderId: ORDER_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      expectedBuyerAccountId: BUYER_ACCOUNT_ID,
      expectedSource: null,
      tenantId: TEST_TENANT_ID,
    };

    expect(await observeOrderCleanupAuthority(deps, { ...base, orderId: " " })).toEqual({
      outcome: "invalid-request",
      reason: "order-id-required",
    });
    expect(await observeOrderCleanupAuthority(deps, { ...base, expectedBuyerAccountId: "" })).toEqual({
      outcome: "invalid-request",
      reason: "expected-buyer-account-required",
    });
    expect(await observeOrderCleanupAuthority(deps, { ...base, tenantId: "" })).toEqual({
      outcome: "invalid-request",
      reason: "tenant-required",
    });
    expect(reader.calls).toEqual([]);
  });

  it("treats a foreign-tenant Order stream as indistinguishable from a missing Order", async () => {
    const foreign = buildStoredEvents(ORDER_STREAM_ID, [
      { ...created(), tenantId: OTHER_TENANT_ID },
      { ...cancelled(), tenantId: OTHER_TENANT_ID },
    ]);
    const reader = createRecordingStreamReader({ [ORDER_STREAM_ID]: foreign });
    expect(
      await observeBuyerOrderCleanupAuthority(
        { eventStore: reader, inventory: createStubInventoryAuthority(ACTIVE_HOLD_AUTHORITY) },
        {
          orderId: ORDER_ID,
          windowOpenedAt: WINDOW_OPENED_AT,
          buyerAccountId: BUYER_ACCOUNT_ID,
          tenantId: TEST_TENANT_ID,
        },
      ),
    ).toEqual({ outcome: "not-found" });
  });

  it("treats a non-contiguous or duplicated Order history as unreadable", async () => {
    const gapped: StoredEvent[] = buildStoredEvents(ORDER_STREAM_ID, [created(), { ...confirmed(), streamVersion: 5 }]);
    const reader = createRecordingStreamReader({ [ORDER_STREAM_ID]: gapped });
    expect(
      await observeBuyerOrderCleanupAuthority(
        { eventStore: reader, inventory: createStubInventoryAuthority({}) },
        {
          orderId: ORDER_ID,
          windowOpenedAt: WINDOW_OPENED_AT,
          buyerAccountId: BUYER_ACCOUNT_ID,
          tenantId: TEST_TENANT_ID,
        },
      ),
    ).toEqual({ outcome: "conflict", reason: "order-stream-unreadable" });
  });
});
