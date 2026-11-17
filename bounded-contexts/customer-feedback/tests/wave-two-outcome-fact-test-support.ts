import {
  decideFulfillmentShipment,
  initialFulfillmentShipmentState,
} from "../../fulfillment/features/shipments/domain/domain";
import { decidePayment, evolvePayment, initialPaymentState } from "../../payments/features/payments/domain/domain";
import { decidePayout, evolvePayout, initialPayoutState } from "../../settlement/features/payouts/domain/domain";
import {
  decideSupportRequest,
  evolveSupportRequest,
  initialSupportRequestState,
} from "../../platform-operations/features/support-requests/domain/domain";

export const outcomeOccurredAt = "2026-05-09T14:00:00.000Z";

export function deliveryFact() {
  return decideFulfillmentShipment(
    {
      ...initialFulfillmentShipmentState,
      shipmentId: "shp_native" as never,
      orderId: "ord_native" as never,
      buyerAccountId: "acc_buyer" as never,
      status: "dispatched",
      shippingDestinationSnapshot: {
        name: "Buyer",
        company: null,
        line1: "1 Main",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        phone: null,
        email: null,
      },
    },
    { type: "RecordShipmentDelivery", deliveredAt: outcomeOccurredAt },
  ).find((event) => event.type === "fulfillment.shipment.delivered")!;
}

export function captureFact(sourceContext: string | null) {
  const state = decidePayment(initialPaymentState, {
    type: "CreatePayment",
    paymentId: "pay_native" as never,
    buyerAccountId: "acc_buyer" as never,
    orderIds: ["ord_native" as never],
    amount: "10.00",
    marketplaceSalesFeeAmount: "1.00",
    marketplaceCheckoutFeeAmount: "0.50",
    sellerNetAmount: "8.50",
    currencyCode: "usd",
    processorName: "stripe",
    processorPaymentKind: "payment-intent",
    processorPaymentReference: "pi_native",
    processorClientSecret: null,
    processorStatus: "requires_payment_method",
    sourceContext,
    createdAt: "2026-05-09T12:00:00.000Z",
  }).reduce(evolvePayment, initialPaymentState);
  return decidePayment(state, {
    type: "RecordPaymentCapture",
    processorStatus: "succeeded",
    capturedAt: outcomeOccurredAt,
  }).find((event) => event.type === "payments.payment-captured")!;
}

export function payoutFact() {
  const state = decidePayout(initialPayoutState, {
    type: "RequestPayout",
    payoutId: "pyo_native" as never,
    accountId: "acc_seller" as never,
    requestedAmount: "25.00",
    feeAmount: "1.00",
    netAmount: "24.00",
    currencyCode: "usd",
    requestedAt: "2026-05-09T12:00:00.000Z",
  }).reduce(evolvePayout, initialPayoutState);
  return decidePayout(state, { type: "CompletePayout", completedAt: outcomeOccurredAt }).find(
    (event) => event.type === "settlement.payout.completed",
  )!;
}

export function supportFact(flowType: "return-request" | "product-not-received") {
  const state = decideSupportRequest(initialSupportRequestState, {
    type: "OpenSupportRequest",
    supportRequestId: "sup_native" as never,
    orderId: "ord_native" as never,
    orderTotalAmount: "25.00",
    buyerAccountId: "acc_buyer" as never,
    sellerAccountId: "acc_seller" as never,
    flowType,
    openedByAccountId: "acc_buyer" as never,
    openedByRole: "buyer",
    openedAt: "2026-05-09T12:00:00.000Z",
  }).reduce(evolveSupportRequest, initialSupportRequestState);
  return decideSupportRequest(state, {
    type: "ResolveSupportRequest",
    resolutionType: "no-action",
    summary: "Operator reviewed the request.",
    resolvedByAccountId: "acc_support" as never,
    resolvedByRole: "support",
    resolvedAt: outcomeOccurredAt,
    responsibility: "undetermined",
    evidenceBasis: { type: "insufficient-evidence", reference: "support.native-parity.v1" },
    responsibilityReasonCode: `${flowType}.conflicting-evidence`,
  }).find((event) => event.type === "support.support-request.resolved")!;
}
