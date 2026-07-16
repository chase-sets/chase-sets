import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION, type StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createRefundRuntime } from "./runtime";

function storedEvent(input: {
  streamId: string;
  streamVersion: number;
  globalPosition: number;
  eventType: string;
  payload: JsonObject;
}): StoredEvent {
  return {
    eventId: `evt_${input.globalPosition}` as never,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    globalPosition: String(input.globalPosition) as GlobalPosition,
    tenantId: "tnt_test" as never,
    eventType: input.eventType,
    payload: input.payload,
    metadata: {},
    occurredAt: "2026-06-01T00:00:00.000Z" as never,
    recordedAt: "2026-06-01T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_buyer" as never,
  };
}

function createEventStore(events: readonly StoredEvent[]): EventStore {
  return {
    appendToStream: vi.fn(async (_input: AppendToStreamInput) => {
      throw new Error("Existing issued refund retry must not append events.");
    }),
    readStream: vi.fn(async (input: ReadStreamInput) =>
      events.filter((event) => event.streamId === input.streamId && event.streamVersion >= (input.fromVersion ?? 1)),
    ),
    readAll: vi.fn(async (_input?: ReadAllInput) => events),
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
    saveCheckpoint: vi.fn(async () => {}),
  };
}

function capturedPaymentRow() {
  return {
    payment_id: "pay_1",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "10.00",
    balance_credit_amount: "0.00",
    processor_amount: "10.00",
    marketplace_sales_fee_amount: "0.00",
    marketplace_checkout_fee_amount: "0.00",
    marketplace_checkout_fee_policy_version: null,
    marketplace_checkout_fee_quote_fingerprint: null,
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "10.00",
    seller_payout_amount: "10.00",
    seller_payouts: [],
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_1",
    processor_client_secret: "pi_1_secret",
    processor_redirect_url: null,
    processor_status: "succeeded",
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "partially-refunded",
    failure_code: null,
    failure_message: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    captured_at: "2026-06-01T00:00:00.000Z",
    failed_at: null,
    cancelled_at: null,
    refunded_at: "2026-06-01T00:01:00.000Z",
    refunded_amount: "10.00",
    disputed_at: null,
  };
}

describe("refund runtime", () => {
  it("returns an existing issued refund retry without creating another provider refund", async () => {
    const streamId = "payments.refund-rfd_retry";
    const events = [
      storedEvent({
        streamId,
        streamVersion: 1,
        globalPosition: 1,
        eventType: "payments.refund-requested",
        payload: {
          refundId: "rfd_retry",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Support sup_1: refund approved",
          processorName: "stripe",
          requestedAt: "2026-06-01T00:00:00.000Z",
        },
      }),
      storedEvent({
        streamId,
        streamVersion: 2,
        globalPosition: 2,
        eventType: "payments.refund-issued",
        payload: {
          refundId: "rfd_retry",
          paymentId: "pay_1",
          orderIds: ["ord_1"],
          amount: "10.00",
          currencyCode: "usd",
          reason: "Support sup_1: refund approved",
          processorName: "stripe",
          processorRefundReference: "re_retry",
          processorStatus: "succeeded",
          issuedAt: "2026-06-01T00:01:00.000Z",
        },
      }),
    ];
    const createRefund = vi.fn(async () => {
      throw new Error("Existing issued refund retry must not call the processor.");
    });
    const services = createRefundRuntime({
      eventStore: createEventStore(events),
      checkpointStore: createCheckpointStore(),
      db: {
        query: vi.fn(async () => ({ rows: [capturedPaymentRow()] })),
      } as never,
      processorGateway: {
        createRefund,
      } as never,
    });

    await expect(
      services.issueRefund(
        {
          refundId: "rfd_retry" as never,
          paymentId: "pay_1" as never,
          orderIds: ["ord_1"],
          amount: "10.00",
          reason: "Support sup_1: refund approved",
        },
        {
          tenantId: "tnt_test" as never,
          audit: {
            performedByUserId: "usr_test" as never,
            forAccountId: "acc_buyer" as never,
          },
        },
      ),
    ).resolves.toEqual({ outcome: "requested", refundId: "rfd_retry", version: 2, amount: "10.00" });
    expect(createRefund).not.toHaveBeenCalled();
  });
});

function capturedPaymentRowFresh() {
  return {
    ...capturedPaymentRow(),
    status: "captured",
    refunded_amount: "0.00",
    refunded_at: null,
    order_refund_caps: [{ orderId: "ord_1", amount: "10.00" }],
    order_refunded_amounts: [],
  };
}

function paymentCreatedPayload(): JsonObject {
  return {
    paymentId: "pay_1",
    buyerAccountId: "acc_buyer",
    orderIds: ["ord_1"],
    amount: "10.00",
    balanceCreditAmount: "0.00",
    processorAmount: "10.00",
    marketplaceSalesFeeAmount: "0.00",
    authenticityFeeAmount: "0.00",
    marketplaceCheckoutFeeAmount: "0.00",
    marketplaceCheckoutFeePolicyVersion: null,
    marketplaceCheckoutFeeQuoteFingerprint: null,
    paymentMethodCategory: "card",
    savedCheckoutInstrumentId: null,
    sellerNetAmount: "10.00",
    sellerPayoutAmount: "10.00",
    sellerPayouts: [],
    orderRefundCaps: [{ orderId: "ord_1", amount: "10.00" }],
    currencyCode: "usd",
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference: "pi_1",
    processorClientSecret: "pi_1_secret",
    processorRedirectUrl: null,
    processorStatus: "succeeded",
    sourceContext: "checkout",
    sourceReferenceId: "chk_1",
    threeDSecureRequest: null,
    threeDSecureReasonCodes: [],
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

/** In-memory event store honouring optimistic-concurrency append, so issueRefund exercises real aggregate state. */
function createInMemoryEventStore(seed: readonly StoredEvent[]): EventStore {
  const events: StoredEvent[] = [...seed];
  let globalCounter = events.length;
  return {
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      const currentVersion = events.filter((event) => event.streamId === input.streamId).length;
      if (input.expectedVersion === "no_stream") {
        if (currentVersion !== 0) {
          throw new Error(`Stream ${input.streamId} already exists.`);
        }
      } else if (input.expectedVersion !== "any" && Number(input.expectedVersion) !== currentVersion) {
        throw new Error(
          `Version conflict on ${input.streamId}: expected ${input.expectedVersion}, got ${currentVersion}.`,
        );
      }
      const appended = input.events.map((record, index) => {
        globalCounter += 1;
        return storedEvent({
          streamId: input.streamId,
          streamVersion: currentVersion + index + 1,
          globalPosition: globalCounter,
          eventType: record.eventType,
          payload: record.payload,
        });
      });
      events.push(...appended);
      return appended;
    }),
    readStream: vi.fn(async (input: ReadStreamInput) =>
      events.filter((event) => event.streamId === input.streamId && event.streamVersion >= (input.fromVersion ?? 1)),
    ),
    readAll: vi.fn(async (_input?: ReadAllInput) => events),
  };
}

function capturedPaymentEvents(): StoredEvent[] {
  return [
    storedEvent({
      streamId: "payments.payment-pay_1",
      streamVersion: 1,
      globalPosition: 1,
      eventType: "payments.payment-created",
      payload: paymentCreatedPayload(),
    }),
    storedEvent({
      streamId: "payments.payment-pay_1",
      streamVersion: 2,
      globalPosition: 2,
      eventType: "payments.payment-captured",
      payload: { paymentId: "pay_1", processorStatus: "succeeded", capturedAt: "2026-06-01T00:00:30.000Z" },
    }),
  ];
}

const refundContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
};

describe("refund runtime money safety", () => {
  it("surfaces a gateway failure distinctly instead of returning success-shaped", async () => {
    const createRefund = vi.fn(async () => {
      throw new Error("processor timeout");
    });
    const services = createRefundRuntime({
      eventStore: createInMemoryEventStore(capturedPaymentEvents()),
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [capturedPaymentRowFresh()] })) } as never,
      processorGateway: { createRefund } as never,
    });

    const result = await services.issueRefund(
      {
        refundId: "rfd_fail" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "10.00",
        reason: "Support sup_1: refund approved",
        capToRemainingRefundable: true,
      },
      refundContext,
    );

    expect(result.outcome).toBe("gateway-failed");
    expect(createRefund).toHaveBeenCalledTimes(1);
  });

  it("retries a transient gateway failure with the same refund id and refunds exactly once", async () => {
    let attempts = 0;
    const createRefund = vi.fn(async (_input: { refundId: string }) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("processor timeout");
      }
      return { processorName: "stripe", processorRefundReference: "re_1", processorStatus: "pending" };
    });
    const eventStore = createInMemoryEventStore(capturedPaymentEvents());
    const services = createRefundRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [capturedPaymentRowFresh()] })) } as never,
      processorGateway: { createRefund } as never,
    });

    const first = await services.issueRefund(
      {
        refundId: "rfd_retry_once" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "10.00",
        reason: "Support sup_1: refund approved",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    expect(first.outcome).toBe("gateway-failed");

    const second = await services.issueRefund(
      {
        refundId: "rfd_retry_once" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "10.00",
        reason: "Support sup_1: refund approved",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    expect(second).toMatchObject({ outcome: "requested", refundId: "rfd_retry_once", amount: "10.00" });

    // Same refund id both times (processor idempotency key dedupes a real double-submit).
    expect(createRefund).toHaveBeenCalledTimes(2);
    for (const call of createRefund.mock.calls) {
      expect(call[0].refundId).toBe("rfd_retry_once");
    }
    // Exactly one reservation on the payment stream -> no double refund.
    const appended = await eventStore.readStream({ streamId: "payments.payment-pay_1" as never });
    const reservations = appended.filter((event) => event.eventType === "payments.payment-refund-requested");
    expect(reservations).toHaveLength(1);
  });

  it("caps cumulatively per order: a second full refund on the same order is not-refundable", async () => {
    const createRefund = vi.fn(async () => ({
      processorName: "stripe",
      processorRefundReference: "re_1",
      processorStatus: "pending",
    }));
    const services = createRefundRuntime({
      eventStore: createInMemoryEventStore(capturedPaymentEvents()),
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [capturedPaymentRowFresh()] })) } as never,
      processorGateway: { createRefund } as never,
    });

    const first = await services.issueRefund(
      {
        refundId: "rfd_support_a" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "10.00",
        reason: "Support sup_a: refund approved",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    expect(first.outcome).toBe("requested");

    const second = await services.issueRefund(
      {
        refundId: "rfd_support_b" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "10.00",
        reason: "Support sup_b: refund approved",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    expect(second.outcome).toBe("not-refundable");
    expect(createRefund).toHaveBeenCalledTimes(1);
  });

  it("clamps a partial second refund to the order's remaining refundable", async () => {
    const createRefund = vi.fn(async (_input: { refundId: string; amount: string }) => ({
      processorName: "stripe",
      processorRefundReference: "re_1",
      processorStatus: "pending",
    }));
    const services = createRefundRuntime({
      eventStore: createInMemoryEventStore(capturedPaymentEvents()),
      checkpointStore: createCheckpointStore(),
      db: { query: vi.fn(async () => ({ rows: [capturedPaymentRowFresh()] })) } as never,
      processorGateway: { createRefund } as never,
    });

    await services.issueRefund(
      {
        refundId: "rfd_partial_a" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "6.00",
        reason: "Support sup_a",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    const second = await services.issueRefund(
      {
        refundId: "rfd_partial_b" as never,
        paymentId: "pay_1" as never,
        orderIds: ["ord_1"],
        amount: "6.00",
        reason: "Support sup_b",
        capToRemainingRefundable: true,
      },
      refundContext,
    );
    // Only 4.00 remained; the request is clamped rather than rejected or over-refunded.
    expect(second).toMatchObject({ outcome: "requested", amount: "4.00" });
    expect(createRefund).toHaveBeenLastCalledWith(expect.objectContaining({ amount: "4.00" }));
  });
});
