import { describe, expect, it, vi } from "vitest";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import {
  initialPaymentState,
  type PaymentCommand,
  type PaymentDisputedEvent,
  type PaymentEvent,
  type PaymentState,
} from "../../domain/domain";
import { assembleProcessorDisputeEvidence, submitPaymentDisputeEvidence } from "./dispute-evidence-submission";
import type { PaymentsFulfillmentDisputeEvidenceSourceRow } from "./dispute-evidence-queries";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_system" as never,
    forAccountId: "acc_system" as never,
  },
};

function dispute(overrides: Partial<PaymentDisputedEvent["data"]> = {}): PaymentDisputedEvent["data"] {
  return {
    paymentId: "pay_1" as never,
    orderIds: ["ord_1" as never],
    buyerAccountId: "acc_buyer" as never,
    amount: "42.00",
    currencyCode: "usd",
    processorName: "stripe",
    processorPaymentReference: "pi_1",
    providerEventId: "evt_dispute",
    providerDisputeId: "dp_1",
    providerChargeReference: "ch_1",
    processorStatus: "needs_response",
    disputeStatus: "charge.dispute.created",
    disputeMessage: "needs_response",
    disputeLifecycleState: "created",
    disputeReason: "product_not_received",
    disputeEvidenceDueAt: "2026-08-04T00:00:00.000Z",
    sellerPayouts: [
      {
        orderId: "ord_1" as never,
        sellerAccountId: "acc_seller" as never,
        sellerItemNetAmount: "38.00",
        shippingAllowanceAmount: "4.00",
        sellerShippingPayoutAmount: "4.00",
        sellerPayoutAmount: "42.00",
      },
    ],
    disputedAt: "2026-07-06T12:00:00.000Z",
    ...overrides,
  };
}

function orderRow() {
  return {
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    buyer_email: "buyer@example.test",
    shipping_destination_snapshot: null,
    seller_account_id: "acc_seller",
    sales_tax_amount: "0.00",
    total_amount: "42.00",
    marketplace_sales_fee_amount: "2.00",
    authenticity_fee_amount: "0.00",
    marketplace_checkout_fee_amount: "1.00",
    seller_net_amount: "38.00",
    seller_item_net_amount: "38.00",
    shipping_allowance_amount: "4.00",
    shipping_overage_amount: "0.00",
    seller_shipping_payout_amount: "4.00",
    seller_payout_amount: "42.00",
    shipping_allowance_percentage_bps: 500,
    terms_schedule_id: "terms_1",
    terms_agreement_id: "agreement_1",
    terms_resolved_at: "2026-07-01T00:00:00.000Z",
    status: "ready-for-fulfillment",
    pending_payment_at: null,
    payment_deadline_at: null,
    payment_deadline_policy: null,
  };
}

function shipment(overrides: Partial<PaymentsFulfillmentDisputeEvidenceSourceRow> = {}) {
  return {
    shipment_id: "shp_1",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    status: "delivered",
    shipping_method: "priority",
    carrier_name: "USPS",
    tracking_identifier: "940000000000000000",
    shipping_destination_snapshot: {
      name: "Buyer Example",
      line1: "123 Test St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      email: "buyer@example.test",
    },
    lines: [
      {
        itemTitle: "Test card",
        itemSubtitle: "Near Mint",
        productSummary: "Chase Sets test listing",
        quantity: 1,
      },
    ],
    label_attached_at: "2026-07-02T10:00:00.000Z",
    dispatched_at: "2026-07-02T18:00:00.000Z",
    delivered_at: "2026-07-04T15:00:00.000Z",
    updated_at: "2026-07-04T15:00:00.000Z",
    ...overrides,
  } satisfies PaymentsFulfillmentDisputeEvidenceSourceRow;
}

function fakeDb(
  params: Readonly<{
    shipments: readonly PaymentsFulfillmentDisputeEvidenceSourceRow[];
    idempotencyExists?: boolean;
  }>,
): PgQueryable {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM payments_order_inputs")) {
        return { rows: [orderRow()], rowCount: 1 };
      }
      if (sql.includes("FROM payments_fulfillment_dispute_evidence_sources")) {
        return { rows: [...params.shipments], rowCount: params.shipments.length };
      }
      if (sql.includes("FROM payments_provider_idempotency_keys")) {
        return {
          rows: params.idempotencyExists
            ? [
                {
                  operation_key: "dispute:dp_1:evidence",
                  provider_name: "stripe",
                  operation_kind: "dispute-evidence-submit",
                  account_id: "acc_buyer",
                  provider_object_reference: "dp_1",
                  idempotency_key: "payments:dispute:dp_1:evidence",
                  created_at: "2026-07-06T12:01:00.000Z",
                },
              ]
            : [],
          rowCount: params.idempotencyExists ? 1 : 0,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function gateway(): PaymentProcessorGateway {
  const getPublicConfiguration: PaymentProcessorGateway["getPublicConfiguration"] = () => ({
    processorName: "stripe",
    publishableKey: "pk_test",
    confirmationExperience: "processor-managed-form",
    dynamicPaymentMethods: true,
    sensitivePaymentDetailsHandledByProcessor: true,
  });
  const submitDisputeEvidence: NonNullable<PaymentProcessorGateway["submitDisputeEvidence"]> = async () => ({
    processorName: "stripe",
    providerDisputeId: "dp_1",
    processorStatus: "under_review",
    submittedAt: "2026-07-06T12:01:00.000Z",
  });
  const processorGateway = {
    getPublicConfiguration: vi.fn(getPublicConfiguration),
    createCustomer: vi.fn(),
    createSetupSession: vi.fn(),
    retrieveSetupSessionResult: vi.fn(),
    retrieveSavedPaymentMethod: vi.fn(),
    detachSavedPaymentMethod: vi.fn(),
    createPaymentSession: vi.fn(),
    cancelPayment: vi.fn(),
    retrievePaymentResult: vi.fn(),
    createRefund: vi.fn(),
    parseWebhook: vi.fn(),
    submitDisputeEvidence: vi.fn(submitDisputeEvidence),
  } satisfies PaymentProcessorGateway;

  return processorGateway;
}

function paymentCommandHandler(): CommandHandler<PaymentCommand, PaymentState, PaymentEvent> {
  const handler: CommandHandler<PaymentCommand, PaymentState, PaymentEvent> = async () => ({
    state: initialPaymentState,
    version: 1,
    newEvents: [],
    storedEvents: [],
  });

  return vi.fn(handler);
}

describe("payment dispute evidence submission", () => {
  it("assembles tracking, delivery proof, address, product, and settlement context", () => {
    const assembled = assembleProcessorDisputeEvidence({
      dispute: dispute(),
      orders: [orderRow()],
      fulfillmentSources: [shipment()],
    });

    expect(assembled?.evidence).toMatchObject({
      customerEmailAddress: "buyer@example.test",
      customerName: "Buyer Example",
      shippingCarrier: "USPS",
      shippingDate: "2026-07-02",
      shippingTrackingNumber: "940000000000000000",
    });
    expect(assembled?.evidence.shippingAddress).toContain("123 Test St");
    expect(assembled?.evidence.productDescription).toContain("Test card - Near Mint");
    expect(assembled?.evidence.uncategorizedText).toContain("Delivery confirmed at 2026-07-04T15:00:00.000Z.");
    expect(assembled?.evidence.uncategorizedText).toContain("Settlement exposure references: ord_1");
    expect(assembled?.evidenceSummary).toMatchObject({
      deliveredAt: "2026-07-04T15:00:00.000Z",
      hasDeliveryProof: true,
    });
  });

  it("submits tracking evidence without delivery proof when delivery is not confirmed yet", () => {
    const assembled = assembleProcessorDisputeEvidence({
      dispute: dispute(),
      orders: [orderRow()],
      fulfillmentSources: [shipment({ status: "dispatched", delivered_at: null })],
    });

    expect(assembled?.evidence.shippingTrackingNumber).toBe("940000000000000000");
    expect(assembled?.evidence.uncategorizedText).not.toContain("Delivery confirmed");
    expect(assembled?.evidenceSummary.hasDeliveryProof).toBe(false);
  });

  it("cites buyer-confirmed unverified address facts in dispute evidence", () => {
    const assembled = assembleProcessorDisputeEvidence({
      dispute: dispute(),
      orders: [orderRow()],
      fulfillmentSources: [
        shipment({
          shipping_destination_snapshot: {
            ...shipment().shipping_destination_snapshot!,
            verification: {
              status: "unverified",
              source: "easypost:test",
              checkedAt: "2026-07-07T00:00:00.000Z",
              buyerDecision: "kept-original",
              suggestedAddress: {
                name: "Buyer Example",
                line1: "123 Test Street",
                line2: null,
                city: "Chicago",
                state: "IL",
                postalCode: "60601-1000",
                country: "US",
                email: "buyer@example.test",
              },
            },
          },
        }),
      ],
    });

    expect(assembled?.evidence.uncategorizedText).toContain(
      "Address verification status: unverified via easypost:test at 2026-07-07T00:00:00.000Z.",
    );
    expect(assembled?.evidence.uncategorizedText).toContain(
      "Buyer confirmed the original unverified shipping address.",
    );
  });

  it("records no tracking available without submitting to Stripe", async () => {
    const processorGateway = gateway();
    const commandHandler = paymentCommandHandler();

    const result = await submitPaymentDisputeEvidence(
      {
        db: fakeDb({ shipments: [] }),
        processorGateway,
        commandHandler,
      },
      dispute(),
      context,
    );

    expect(result).toMatchObject({ status: "unavailable", reason: "tracking-unavailable" });
    expect(processorGateway.submitDisputeEvidence).not.toHaveBeenCalled();
    expect(commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ type: "RecordPaymentDisputeEvidenceUnavailable" }),
      }),
    );
  });

  it("does not submit again when the provider idempotency ledger already recorded the dispute evidence", async () => {
    const processorGateway = gateway();
    const commandHandler = paymentCommandHandler();

    const result = await submitPaymentDisputeEvidence(
      {
        db: fakeDb({ shipments: [shipment()], idempotencyExists: true }),
        processorGateway,
        commandHandler,
      },
      dispute(),
      context,
    );

    expect(result.status).toBe("submitted");
    expect(processorGateway.submitDisputeEvidence).not.toHaveBeenCalled();
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
