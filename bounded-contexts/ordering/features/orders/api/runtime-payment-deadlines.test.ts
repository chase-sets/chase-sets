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

function createDeadlineDb(candidateOrderIds: readonly string[], queryCalls: QueryCall[]) {
  return {
    query: vi.fn(async (text: string, values?: readonly unknown[]) => {
      queryCalls.push({ text, values });
      if (text.includes("FROM ordering_order_pages AS page") && text.includes("payment_deadline_at")) {
        return {
          rows: candidateOrderIds.map((orderId) => ({
            order_id: orderId,
            payment_deadline_at: "2026-03-31T01:00:00.000Z",
            payment_deadline_policy: "ordering-payment-deadline-card-v1",
          })),
          rowCount: candidateOrderIds.length,
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
      services.sweepBreachedPaymentDeadlines({ now: new Date("2026-03-31T01:00:00.000Z"), limit: 10 }, context),
    ).resolves.toEqual({ checked: 1, cancelled: 1, progressed: 0, failed: 0 });

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
    expect(queryCalls[0]?.values).toEqual(["2026-03-31T01:00:00.000Z", 10]);
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
      services.sweepBreachedPaymentDeadlines({ now: new Date("2026-03-31T01:00:00.000Z"), limit: 10 }, context),
    ).resolves.toEqual({ checked: 1, cancelled: 0, progressed: 1, failed: 0 });

    expect(readAllEvents().filter((event) => event.eventType === "ordering.order.cancelled")).toEqual([]);
  });
});
