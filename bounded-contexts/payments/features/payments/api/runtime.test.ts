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
    saveCheckpoint: vi.fn(async (_projectionName: string, _checkpoint: GlobalPosition) => {}),
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
    marketplace_checkout_fee_policy_version: "marketplace-checkout-fee-v1",
    marketplace_checkout_fee_quote_fingerprint: "quote_1",
    payment_method_category: "card",
    saved_checkout_instrument_id: null,
    seller_net_amount: "23.49",
    seller_payout_amount: "24.49",
    seller_payouts: [],
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
    refunded_at: null,
    refunded_amount: "0.00",
    disputed_at: null,
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
    createPaymentSession: vi.fn(async (input: { paymentId: string; amount: string; returnUrl?: string | null }) => ({
      processorName: "stripe" as const,
      processorPaymentKind: "payment-intent" as const,
      processorPaymentReference: `pi_${input.paymentId}`,
      processorClientSecret: `secret_${input.paymentId}`,
      processorRedirectUrl: null,
      processorStatus: "requires_payment_method",
    })),
    createCustomer: vi.fn(async () => ({
      processorName: "stripe" as const,
      providerCustomerReference: "cus_buyer",
    })),
    createSetupSession: vi.fn(async () => ({
      processorName: "stripe" as const,
      processorSetupKind: "checkout-setup-session" as const,
      processorSetupReference: "cs_setup",
      processorClientSecret: null,
      processorRedirectUrl: "https://checkout.stripe.test/setup",
      processorStatus: "open",
    })),
    retrieveSetupSessionResult: vi.fn(async () => ({
      processorName: "stripe" as const,
      processorSetupReference: "cs_setup",
      processorStatus: "complete",
      setupIntentReference: "seti_setup",
      savedPaymentMethod: null,
    })),
    retrieveSavedPaymentMethod: vi.fn(async () => null),
    detachSavedPaymentMethod: vi.fn(async () => null),
    createRefund: vi.fn(async () => {
      throw new Error("Refunds are not part of this test.");
    }),
    parseWebhook: vi.fn(async () => null),
  };
}

function createOrderInputDb(
  options: Readonly<{ savedCheckoutInstrumentRows?: readonly Record<string, unknown>[] }> = {},
) {
  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM payments_saved_checkout_instruments")) {
        return { rows: [...(options.savedCheckoutInstrumentRows ?? [])] };
      }

      if (sql.includes("FROM payments_order_inputs")) {
        expect(params).toEqual(["acc_buyer", ["ord_1"]]);
        return {
          rows: [
            {
              order_id: "ord_1",
              buyer_account_id: "acc_buyer",
              buyer_email: "buyer@example.com",
              seller_account_id: "acc_seller",
              sales_tax_amount: "1.57",
              total_amount: "24.99",
              marketplace_sales_fee_amount: "1.00",
              marketplace_checkout_fee_amount: "0.50",
              seller_net_amount: "23.49",
              seller_item_net_amount: "23.49",
              shipping_allowance_amount: "1.00",
              shipping_overage_amount: "3.99",
              seller_shipping_payout_amount: "1.00",
              seller_payout_amount: "24.49",
              shipping_allowance_percentage_bps: 500,
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
  it("returns account order overlays from Payments order inputs", async () => {
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway: createProcessorGateway(),
    });

    const orders = await services.listAccountOrderInputs({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
    });

    expect(orders).toEqual([
      expect.objectContaining({
        order_id: "ord_1",
        buyer_email: "buyer@example.com",
        sales_tax_amount: "1.57",
        total_amount: "24.99",
        seller_payout_amount: "24.49",
      }),
    ]);
  });

  it("does not mark provider webhooks processed when the payment target is not ready", async () => {
    const processorGateway = createProcessorGateway();
    processorGateway.parseWebhook.mockResolvedValue({
      eventId: "evt_refund_before_payment",
      processorName: "stripe",
      kind: "payment-refunded",
      processorPaymentReference: "pi_missing",
      processorRefundReference: "re_missing",
      processorStatus: "succeeded",
      amount: "12.50",
      occurredAt: "2026-04-29T00:10:00.000Z",
    } as never);
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_provider_webhook_events")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO payments_provider_webhook_events")) {
          throw new Error("Provider event should not be marked processed before payment effects commit.");
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    const services = createPaymentRuntime({
      eventStore: createUnusedEventStore(),
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    await expect(services.processWebhook({ rawBody: "{}", signatureHeader: "sig" }, context)).rejects.toThrow(
      "Payment webhook target was not found.",
    );
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO payments_provider_webhook_events")),
    ).toBe(false);
  });

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
      createCustomer: vi.fn(async () => ({
        processorName: "stripe" as const,
        providerCustomerReference: "cus_buyer",
      })),
      createSetupSession: vi.fn(async () => ({
        processorName: "stripe" as const,
        processorSetupKind: "checkout-setup-session" as const,
        processorSetupReference: "cs_setup",
        processorClientSecret: null,
        processorRedirectUrl: "https://checkout.stripe.test/setup",
        processorStatus: "open",
      })),
      retrieveSetupSessionResult: vi.fn(async () => ({
        processorName: "stripe" as const,
        processorSetupReference: "cs_setup",
        processorStatus: "complete",
        setupIntentReference: "seti_setup",
        savedPaymentMethod: null,
      })),
      retrieveSavedPaymentMethod: vi.fn(async () => null),
      detachSavedPaymentMethod: vi.fn(async () => null),
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
    const db = createOrderInputDb();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
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
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
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
    const providerOperationCall = db.query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO payments_provider_operations"),
    );
    expect(providerOperationCall).toBeTruthy();
    expect(String(providerOperationCall![0])).not.toContain("request_json");
    const providerOperationParams = providerOperationCall![1] as readonly unknown[];
    expect(providerOperationParams).toHaveLength(7);
    expect(JSON.stringify(providerOperationParams)).not.toContain("clientRiskContext");
    expect(JSON.stringify(providerOperationParams)).not.toContain("savedCheckoutInstrument");
    expect(db.query.mock.invocationCallOrder[db.query.mock.calls.indexOf(providerOperationCall!)]).toBeLessThan(
      processorGateway.createPaymentSession.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      amount: "25.75",
      balance_credit_amount: "10.00",
      processor_amount: "15.75",
      marketplace_checkout_fee_amount: "0.76",
      seller_payout_amount: "24.49",
      seller_payouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "23.49",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "24.49",
        },
      ],
      status: "pending-confirmation",
    });
    expect(readAllEvents()[0]?.payload).toMatchObject({
      sellerPayoutAmount: "24.49",
      sellerPayouts: [
        {
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          sellerItemNetAmount: "23.49",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
          sellerPayoutAmount: "24.49",
        },
      ],
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual(["payments.payment-created"]);
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
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
      },
      context,
    );

    expect(processorGateway.createPaymentSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      amount: "24.99",
      balance_credit_amount: "24.99",
      processor_amount: "0.00",
      processor_status: "balance-credit-captured",
      seller_payout_amount: "24.49",
      status: "captured",
    });
    expect(readAllEvents()[1]?.payload).toMatchObject({
      sellerPayoutAmount: "24.49",
      sellerPayouts: [
        expect.objectContaining({
          orderId: "ord_1",
          shippingAllowanceAmount: "1.00",
          sellerShippingPayoutAmount: "1.00",
        }),
      ],
    });
    expect(readAllEvents().map((event) => event.eventType)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
    ]);
  });

  it("uses an explicit relative return path for processor payment sessions", async () => {
    const { eventStore } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb() as never,
      processorGateway,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "bank-account",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "bank-account",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        returnUrlBase: "https://market.test",
        returnUrlPath: "/checkout/payments/:paymentId",
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodCategory: "bank-account",
        returnUrl: `https://market.test/checkout/payments/${result.payment_id}`,
      }),
    );
  });

  it("validates and passes a saved checkout instrument to the processor", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const processorGateway = createProcessorGateway();
    const db = createOrderInputDb({
      savedCheckoutInstrumentRows: [
        {
          instrument_id: "sci_card_1",
          account_id: "acc_buyer",
          payment_method_category: "card",
          provider: "stripe",
          provider_customer_reference: "cus_buyer",
          provider_reference: "pm_card_1",
          display_label: "Visa ending in 4242",
          confirmation_experience: "off-session-token",
          readiness: "ready",
          allow_redisplay: "always",
          consent_id: "consent_1",
          consent_text: "Save for future checkout.",
          removed_at: null,
          is_default: true,
          created_at: "2026-04-29T00:00:00.000Z",
          updated_at: "2026-04-29T00:00:00.000Z",
        },
      ],
    });
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: db as never,
      processorGateway,
    });

    const status = await services.getCheckoutStatus({
      accountId: "acc_buyer" as never,
      orderIds: ["ord_1" as never],
      paymentMethodCategory: "card",
    });
    const result = await services.createAccountPayment(
      {
        accountId: "acc_buyer" as never,
        orderIds: ["ord_1" as never],
        paymentMethodCategory: "card",
        marketplaceCheckoutFeeQuoteFingerprint: status.marketplace_checkout_fee.quote_fingerprint,
        savedCheckoutInstrumentId: "sci_card_1",
      },
      context,
    );

    expect(processorGateway.createPaymentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        savedCheckoutInstrument: {
          instrumentId: "sci_card_1",
          providerCustomerReference: "cus_buyer",
          providerReference: "pm_card_1",
          confirmationExperience: "off-session-token",
          displayLabel: "Visa ending in 4242",
        },
      }),
    );
    expect(result.saved_checkout_instrument_id).toBe("sci_card_1");
    expect(readAllEvents()[0]?.payload).toMatchObject({
      savedCheckoutInstrumentId: "sci_card_1",
    });
  });

  it("publishes support-safe checkout affordance facts after saved instrument changes", async () => {
    const { eventStore, readAllEvents } = createInMemoryEventStore();
    const services = createPaymentRuntime({
      eventStore,
      checkpointStore: createCheckpointStore(),
      db: createOrderInputDb({
        savedCheckoutInstrumentRows: [
          {
            instrument_id: "sci_card_1",
            account_id: "acc_buyer",
            payment_method_category: "card",
            provider: "stripe",
            provider_customer_reference: "cus_buyer",
            provider_reference: "pm_card_1",
            display_label: "Visa ending in 4242",
            confirmation_experience: "off-session-token",
            readiness: "ready",
            allow_redisplay: "always",
            consent_id: "consent_1",
            consent_text: "Save for future checkout.",
            removed_at: null,
            is_default: false,
            created_at: "2026-04-29T00:00:00.000Z",
            updated_at: "2026-04-29T00:00:00.000Z",
          },
        ],
      }) as never,
      processorGateway: createProcessorGateway(),
    });

    await services.setSavedCheckoutInstrumentDefault(
      {
        accountId: "acc_buyer" as never,
        instrumentId: "sci_card_1",
      },
      context,
    );

    const published = readAllEvents().find((event) => event.eventType === "payments.checkout-affordances-published");
    expect(published?.streamId).toBe("payments.checkout-affordances-acc_buyer");
    expect(published?.payload).toMatchObject({
      accountId: "acc_buyer",
      savedCheckoutInstruments: [
        {
          instrumentId: "sci_card_1",
          paymentMethodCategory: "card",
          displayLabel: "Visa ending in 4242",
          confirmationExperience: "off-session-token",
          readiness: "ready",
          checkoutEligible: true,
          isDefault: false,
          removedAt: null,
        },
      ],
    });
    expect(JSON.stringify(published?.payload)).not.toContain("provider_reference");
    expect(JSON.stringify(published?.payload)).not.toContain("providerReference");
    expect(JSON.stringify(published?.payload)).not.toContain("provider_customer_reference");
    expect(JSON.stringify(published?.payload)).not.toContain("providerCustomerReference");
    expect(JSON.stringify(published?.payload)).not.toContain("consent");
  });
});
