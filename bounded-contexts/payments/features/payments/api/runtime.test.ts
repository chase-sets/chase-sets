import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createPaymentRuntime } from "./runtime";

function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
          traceId: input.context.trace?.traceId,
          spanId: input.context.trace?.spanId,
          parentSpanId: input.context.trace?.parentSpanId,
          traceState: input.context.trace?.traceState,
        } satisfies StoredEvent;
      });

      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    }),
    readStream: vi.fn(async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    ),
    readAll: vi.fn(async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    }),
  };

  return {
    eventStore,
    readAllEvents: () => allEvents,
  };
}

function createUnusedEventStore(): EventStore {
  return {
    appendToStream: vi.fn(async () => {
      throw new Error("Payment creation should be idempotent.");
    }),
    readStream: vi.fn(async () => []),
    readAll: vi.fn(async () => []),
  };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: vi.fn(async () => ZERO_GLOBAL_POSITION),
    saveCheckpoint: vi.fn(async (_projectorName: string, _checkpoint: GlobalPosition) => {}),
  };
}

function existingPaymentRow() {
  return {
    payment_id: "pay_existing",
    buyer_account_id: "acc_buyer",
    order_ids: ["ord_1"],
    amount: "24.99",
    balance_credit_amount: "0.00",
    processor_amount: "24.99",
    marketplace_sales_fee_amount: "1.00",
    marketplace_checkout_fee_amount: "0.50",
    seller_net_amount: "23.49",
    currency_code: "usd",
    processor_name: "stripe",
    processor_payment_kind: "payment-intent",
    processor_payment_reference: "pi_existing",
    processor_client_secret: "pi_existing_secret",
    processor_redirect_url: null,
    processor_status: "requires_payment_method",
    source_context: "checkout",
    source_reference_id: "chk_1",
    status: "pending-confirmation",
    failure_code: null,
    failure_message: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    captured_at: null,
    failed_at: null,
    cancelled_at: null,
  };
}

function createProcessorGateway() {
  return {
    getPublicConfiguration: vi.fn(() => ({
      processorName: "stripe" as const,
      publishableKey: "pk_test_123",
      confirmationExperience: "processor-managed-form" as const,
      dynamicPaymentMethods: true,
      sensitivePaymentDetailsHandledByProcessor: true,
    })),
    createPaymentSession: vi.fn(async (input: { paymentId: string; amount: string }) => ({
      processorName: "stripe" as const,
      processorPaymentKind: "payment-intent" as const,
      processorPaymentReference: `pi_${input.paymentId}`,
      processorClientSecret: `secret_${input.paymentId}`,
      processorRedirectUrl: null,
      processorStatus: "requires_payment_method",
    })),
    createRefund: vi.fn(async () => {
      throw new Error("Refunds are not part of this test.");
    }),
    parseWebhook: vi.fn(async () => null),
  };
}

function createOrderInputDb() {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM payments_order_inputs")) {
        expect(params).toEqual(["acc_buyer", ["ord_1"]]);
        return {
          rows: [
            {
              order_id: "ord_1",
              buyer_account_id: "acc_buyer",
              total_amount: "24.99",
              marketplace_sales_fee_amount: "1.00",
              marketplace_checkout_fee_amount: "0.50",
              seller_net_amount: "23.49",
              terms_schedule_id: null,
              terms_agreement_id: null,
              terms_resolved_at: "2026-04-29T00:00:00.000Z",
              status: "pending-payment",
            },
          ],
        };
      }

      return { rows: [] };
    }),
  };
}

const context = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_buyer" as never,
  },
};

describe("payment runtime", () => {
  it("reuses checkout-sourced payments by checkout session id", async () => {
    const processorGateway = {
      getPublicConfiguration: vi.fn(() => ({
        processorName: "stripe" as const,
        publishableKey: "pk_test_123",
        confirmationExperience: "processor-managed-form" as const,
        dynamicPaymentMethods: true,
        sensitivePaymentDetailsHandledByProcessor: true,
      })),
      createPaymentSession: vi.fn(async () => {
        throw new Error("Processor payment should not be recreated.");
      }),
      createRefund: vi.fn(async () => {
        throw new Error("Refunds are not part of this test.");
      }),
      parseWebhook: vi.fn(async () => null),
    };
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(sql).toContain("source_context = $1");
        expect(params).toEqual(["checkout", "chk_1", "acc_buyer"]);
        return { rows: [existingPaymentRow()] };
      }),
    };
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      {
        tenantId: "tnt_identity" as never,
        audit: {
          performedByUserId: "usr_1" as never,
          forAccountId: "acc_buyer" as never,
        },
      },
    );

    expect(result).toMatchObject({
      payment_id: "pay_existing",
      source_context: "checkout",
      source_reference_id: "chk_1",
      processor_publishable_key: "pk_test_123",
    });
    expect(processorGateway.createPaymentSession).not.toHaveBeenCalled();
  });

  it("applies available balance credit and creates an external payment for the remainder", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const balanceCreditResolver = {
      resolveBalanceCredit: vi.fn(async () => ({
        requestedAmount: "10.00",
        appliedAmount: "10.00",
        remainingExternalAmount: "14.99",
      })),
    };
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
      balanceCreditResolver,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      requestedBalanceCreditAmount: "10.00",
      paymentMethodCategory: "card",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        requestedBalanceCreditAmount: "10.00",
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint:
          status.marketplace_checkout_fee.quote_fingerprint,
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
      },
      context,
    );

    expect(balanceCreditResolver.resolveBalanceCredit).toHaveBeenCalledWith({
      buyerAccountId: "acc_buyer",
      currencyCode: "usd",
      requestedAmount: "10.00",
      orderTotalAmount: "24.99",
    });
    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "15.75",
        paymentMethodCategory: "card",
      }),
    );
    expect(result).toMatchObject({
      amount: "25.75",
      balance_credit_amount: "10.00",
      processor_amount: "15.75",
      marketplace_checkout_fee_amount: "0.76",
      status: "pending-confirmation",
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
    ]);
  });

  it("captures a payment immediately when balance credit covers the full amount", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
      balanceCreditResolver: {
        resolveBalanceCredit: vi.fn(async () => ({
          requestedAmount: "24.99",
          appliedAmount: "24.99",
          remainingExternalAmount: "0.00",
        })),
      },
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      requestedBalanceCreditAmount: "24.99",
      paymentMethodCategory: "platform-credit",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        requestedBalanceCreditAmount: "24.99",
        paymentMethodCategory: "platform-credit",
        marketplaceCheckoutFeeQuoteFingerprint:
          status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createPaymentSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      amount: "24.99",
      balance_credit_amount: "24.99",
      processor_amount: "0.00",
      processor_status: "balance-credit-captured",
      status: "captured",
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
    ]);
  });
});
