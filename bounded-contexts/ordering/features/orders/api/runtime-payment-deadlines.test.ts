import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import {
  context,
  createCheckpointStore,
  createOrderingOrderRuntimeForTest,
  shipFromAddress,
  shippingAddress,
  taxSnapshot,
} from "./runtime-test-harness";

type QueryCall = Readonly<{
  text: string;
  values?: readonly unknown[];
}>;

function createOrderCommand(orderId = "ord_deadline") {
  return {
    type: "CreateOrder",
    orderId,
    sourceType: "cart-checkout",
    sourceReferenceId: null,
    buyerAccountId: "acc_buyer",
    sellerAccountId: "acc_seller",
    shippingOption: "standard",
    itemSubtotalAmount: "20.00",
    shippingBaseAmount: "4.99",
    shippingDiscountAmount: "0.00",
    shippingChargeAmount: "4.99",
    shippingPlanSnapshot: {},
    salesTaxAmount: "0.00",
    taxSnapshot,
    totalAmount: "24.99",
    shippingDestinationSnapshot: shippingAddress,
    shippingOriginSnapshot: shipFromAddress,
    commercialTermsSnapshot: {
      marketplaceSalesFeeAmount: "1.00",
      sellerNetAmount: "19.00",
      termsScheduleId: "cts_default",
      termsAgreementId: null,
      termsResolvedAt: "2026-03-31T00:00:00.000Z",
    },
    lines: [
      {
        lineId: "oli_1",
        listingId: "lst_1",
        inventoryItemId: "inv_1",
        catalogItemId: "cat_1",
        productId: "cat_1::",
        itemTitle: "Charizard",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        gradedCard: null,
        unitPriceAmount: "20.00",
        quantity: 1,
        lineTotalAmount: "20.00",
        marketplaceSalesFeeUnitAmount: "1.00",
        marketplaceSalesFeeTotalAmount: "1.00",
        sellerNetUnitAmount: "19.00",
        sellerNetTotalAmount: "19.00",
      },
    ],
    reservationRequests: [
      {
        reservationRequestId: "rsv_1",
        inventoryItemId: "inv_1",
        sellerAccountId: "acc_seller",
        quantity: 1,
      },
    ],
  } as const;
}

async function createPendingPaymentOrder(
  services: ReturnType<typeof createOrderingOrderRuntimeForTest>,
  orderId = "ord_deadline",
) {
  await services.commandHandler({
    streamId: `ordering.order-${orderId}`,
    command: createOrderCommand(orderId) as never,
    context,
  });
  await services.commandHandler({
    streamId: `ordering.order-${orderId}`,
    command: {
      type: "RecordReservationConfirmed",
      reservationRequestId: "rsv_1",
      holdId: "hld_1",
      confirmedAt: "2026-03-31T00:00:00.000Z",
    },
    context,
  });
}

function createDeadlineDb(
  candidateOrderIds: readonly string[],
  queryCalls: QueryCall[],
  paymentId: string | null = null,
) {
  return {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queryCalls.push({ text, values });
      if (text.includes("FROM ordering_order_pages AS page") && text.includes("payment_deadline_at")) {
        const [now, limit, afterDeadline, afterOrderId] = values as [string, number, string?, string?];
        const rows = candidateOrderIds
          .map((orderId) => ({
            order_id: orderId,
            buyer_account_id: "acc_buyer",
            payment_id: paymentId,
            payment_deadline_at: orderId === "ord_newer" ? "2026-03-31T01:01:00.000Z" : deadline.now,
          }))
          .filter(
            (row) =>
              row.payment_deadline_at <= now &&
              (!afterDeadline ||
                row.payment_deadline_at > afterDeadline ||
                (row.payment_deadline_at === afterDeadline && row.order_id > (afterOrderId ?? ""))),
          )
          .slice(0, limit);
        return {
          rows,
          rowCount: rows.length,
        };
      }
      if (text.includes("SELECT source_type, source_reference_id, buyer_account_id")) {
        return {
          rows: [{ source_type: "cart-checkout", source_reference_id: null, buyer_account_id: "acc_buyer" }],
          rowCount: 1,
        };
      }
      if (text.includes("FROM ordering_order_line_pages")) {
        return { rows: [{ listing_id: "lst_1" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
  };
}

const shippingQuotePolicy = {
  quote: () => ({
    shippingOption: "standard" as const,
    baseAmount: "4.99",
    discountAmount: "0.00",
    chargeAmount: "4.99",
  }),
};

const deadline = { now: "2026-03-31T01:00:00.000Z", limit: 10 };
const unpaid = async () => "not-captured" as const;

describe("ordering order runtime: payment deadlines", () => {
  it.each([
    ["card", "2026-03-31T01:00:00.000Z", "ordering-payment-deadline-card-v1"],
    ["bank-account", "2026-04-05T00:00:00.000Z", "ordering-payment-deadline-bank-account-v1"],
    ["platform-credit", "2026-03-31T00:15:00.000Z", "ordering-payment-deadline-platform-credit-v1"],
  ] as const)(
    "records %s payment deadlines from pending-payment inputs",
    async (paymentMethodCategory, deadline, token) => {
      const queryCalls: QueryCall[] = [];
      const db = {
        query: vi.fn(async (text: string, values?: readonly unknown[]) => {
          queryCalls.push({ text, values });
          if (text.includes("SELECT order_id, pending_payment_at")) {
            return {
              rows: [{ order_id: "ord_1", pending_payment_at: "2026-03-31T00:00:00.000Z" }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        }),
      };
      const { eventStore } = createInMemoryEventStore();
      const services = createOrderingOrderRuntimeForTest({
        eventStore,
        checkpointStore: createCheckpointStore(),
        db: db as never,
        shippingQuotePolicy,
      });

      await expect(
        services.recordPaymentDeadlineStarted({
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          paymentMethodCategory,
          paymentStartedAt: "2026-03-31T00:00:00.000Z",
        }),
      ).resolves.toBe(1);

      expect(queryCalls.at(-1)?.values).toEqual([
        "ord_1",
        "pay_1",
        paymentMethodCategory,
        deadline,
        token,
        "2026-03-31T00:00:00.000Z",
      ]);
    },
  );

  it("records terminal payment failure deadlines with the grace policy token", async () => {
    const queryCalls: QueryCall[] = [];
    const db = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queryCalls.push({ text, values });
        return { rows: [], rowCount: 2 };
      }),
    };
    const { eventStore } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      shippingQuotePolicy,
    });

    await expect(
      services.recordTerminalPaymentFailureDeadline({
        paymentId: "pay_1",
        orderIds: ["ord_1", "ord_2"],
        failedAt: "2026-03-31T00:00:00.000Z",
        failureCode: "requires_payment_method",
      }),
    ).resolves.toBe(2);

    expect(queryCalls[0]?.values).toEqual([
      ["ord_1", "ord_2"],
      "pay_1",
      "2026-03-31T00:05:00.000Z",
      "ordering-payment-deadline-terminal-failure-grace-v1",
      "2026-03-31T00:00:00.000Z",
      "requires_payment_method",
    ]);
  });

  it("cancels breached pending-payment orders through the order command path", async () => {
    const queryCalls: QueryCall[] = [];
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline"], queryCalls) as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);

    await expect(
      services.sweepBreachedPaymentDeadlines({ ...deadline, reconcilePayment: unpaid }, context),
    ).resolves.toMatchObject({ checked: 1, cancelled: 1, progressed: 0, deferred: 0, failed: 0 });

    expect(readAllEvents().find((event) => event.eventType === "ordering.order.cancelled")?.payload).toMatchObject({
      orderId: "ord_deadline",
      reason: "payment-deadline",
      buyerEmail: "jane@example.com",
      reservationRequests: [
        expect.objectContaining({
          reservationRequestId: "rsv_1",
          holdId: "hld_1",
          status: "confirmed",
        }),
      ],
    });
    expect(queryCalls[0]?.values).toEqual(["2026-03-31T01:00:00.000Z", 11, null, null]);
  });

  it("keeps an expired order whose processor charge succeeded without a webhook", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const reconcilePayment = vi.fn(async () => "captured" as const);
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline"], []) as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);

    await expect(
      services.sweepBreachedPaymentDeadlines(
        { ...deadline, now: "2026-03-31T02:00:00.000Z", reconcilePayment },
        context,
      ),
    ).resolves.toMatchObject({
      checked: 1,
      cancelled: 0,
      progressed: 1,
      deferred: 0,
      failed: 0,
    });

    expect(reconcilePayment).toHaveBeenCalledExactlyOnceWith(
      { orderId: "ord_deadline", buyerAccountId: "acc_buyer" },
      context,
    );
    expect(readAllEvents().some((event) => event.eventType === "ordering.order.cancelled")).toBe(false);
  });

  it("does not cancel on an inconclusive lookup and still processes the next candidate", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const reconcilePayment = vi.fn(unpaid).mockRejectedValueOnce(new Error("processor unavailable"));
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline", "ord_unpaid"], [], "pay_1") as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);
    await createPendingPaymentOrder(services, "ord_unpaid");

    await expect(services.sweepBreachedPaymentDeadlines({ ...deadline, reconcilePayment }, context)).resolves.toEqual({
      checked: 2,
      cancelled: 1,
      progressed: 0,
      deferred: 1,
      deferredByReason: { "payment-unverified": 1, "capture-not-recorded": 0 },
      failed: 0,
    });
    expect(reconcilePayment).toHaveBeenNthCalledWith(
      1,
      { orderId: "ord_deadline", buyerAccountId: "acc_buyer", paymentId: "pay_1" },
      context,
    );
    expect(
      readAllEvents()
        .filter((event) => event.eventType === "ordering.order.cancelled")
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ orderId: "ord_unpaid" })]);
  });

  it("cancels at the deferral limit even when every reconciliation attempt throws", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const reconcilePayment = vi.fn(async () => {
      throw new Error("processor unavailable");
    });
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline"], []) as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);

    await expect(
      services.sweepBreachedPaymentDeadlines(
        { ...deadline, now: "2026-03-31T01:04:59.999Z", reconcilePayment },
        context,
      ),
    ).resolves.toMatchObject({ checked: 1, deferred: 1, cancelled: 0, failed: 0 });
    expect(readAllEvents().some((event) => event.eventType === "ordering.order.cancelled")).toBe(false);

    await expect(
      services.sweepBreachedPaymentDeadlines(
        { ...deadline, now: "2026-03-31T01:05:00.000Z", reconcilePayment },
        context,
      ),
    ).resolves.toMatchObject({ checked: 1, deferred: 0, cancelled: 1, failed: 0 });
    expect(reconcilePayment).toHaveBeenCalledTimes(2);
    expect(readAllEvents().filter((event) => event.eventType === "ordering.order.cancelled")).toHaveLength(1);
  });

  it("reaches a newer overdue order past a full page of confirmed captures that cannot be recorded", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const stuckOrderIds = Array.from({ length: 105 }, (_, index) => `ord_stuck_${String(index).padStart(3, "0")}`);
    const reconcilePayment = vi.fn(async ({ orderId }: { orderId: string }) =>
      orderId === "ord_newer" ? ("not-captured" as const) : ("capture-not-recorded" as const),
    );
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb([...stuckOrderIds, "ord_newer"], []) as never,
      shippingQuotePolicy,
    });
    for (const orderId of [...stuckOrderIds, "ord_newer"]) await createPendingPaymentOrder(services, orderId);

    const sweep = { now: "2026-03-31T02:00:00.000Z", limit: 100, reconcilePayment };
    await expect(services.sweepBreachedPaymentDeadlines(sweep, context)).resolves.toEqual({
      checked: 100,
      cancelled: 0,
      progressed: 0,
      deferred: 100,
      deferredByReason: { "payment-unverified": 0, "capture-not-recorded": 100 },
      failed: 0,
    });
    await expect(services.sweepBreachedPaymentDeadlines(sweep, context)).resolves.toMatchObject({
      checked: 6,
      cancelled: 1,
      deferred: 5,
      failed: 0,
    });
    expect(reconcilePayment).toHaveBeenCalledTimes(106);
    expect(
      readAllEvents()
        .filter((event) => event.eventType === "ordering.order.cancelled")
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ orderId: "ord_newer" })]);
    await expect(services.sweepBreachedPaymentDeadlines(sweep, context)).resolves.toMatchObject({
      checked: 100,
      deferred: 100,
    });
  });

  it("continues cancelling other overdue orders after a cancellation append fails", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore: {
        ...eventStore,
        async appendToStream(input) {
          if (
            input.events.some(
              (event) => event.eventType === "ordering.order.cancelled" && event.payload.orderId === "ord_deadline",
            )
          ) {
            throw new Error("cancellation append unavailable");
          }
          return eventStore.appendToStream(input);
        },
      },
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline", "ord_unpaid"], []) as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);
    await createPendingPaymentOrder(services, "ord_unpaid");

    await expect(
      services.sweepBreachedPaymentDeadlines({ ...deadline, reconcilePayment: unpaid }, context),
    ).resolves.toMatchObject({ checked: 2, cancelled: 1, deferred: 0, failed: 1 });
    expect(
      readAllEvents()
        .filter((event) => event.eventType === "ordering.order.cancelled")
        .map((event) => event.payload),
    ).toEqual([expect.objectContaining({ orderId: "ord_unpaid" })]);
  });

  it("treats capture winning the deadline race as progressed", async () => {
    const queryCalls: QueryCall[] = [];
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createOrderingOrderRuntimeForTest({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createDeadlineDb(["ord_deadline"], queryCalls) as never,
      shippingQuotePolicy,
    });
    await createPendingPaymentOrder(services);
    await services.commandHandler({
      streamId: "ordering.order-ord_deadline",
      command: {
        type: "MarkReadyForFulfillment",
        readyForFulfillmentAt: "2026-03-31T00:59:59.000Z",
      },
      context,
    });

    await expect(
      services.sweepBreachedPaymentDeadlines({ ...deadline, reconcilePayment: unpaid }, context),
    ).resolves.toMatchObject({ checked: 1, cancelled: 0, progressed: 1, deferred: 0, failed: 0 });

    expect(readAllEvents().filter((event) => event.eventType === "ordering.order.cancelled")).toEqual([]);
  });
});
