// Checkout-owned public event payloads.
import type { CheckoutSessionId, PaymentId } from "../../primitives/typed-ids";

export type CheckoutSessionPaymentStartedPayload = Readonly<{
  sessionId: CheckoutSessionId;
  paymentId: PaymentId;
  recordedAt: string;
}>;

export type CheckoutSessionCancelledPayload = Readonly<{
  sessionId: CheckoutSessionId;
  cancelledAt: string;
  releasedReservationIds: readonly string[];
}>;

export type CheckoutEventPayloads = Readonly<{
  "checkout.session.payment-started": CheckoutSessionPaymentStartedPayload;
  "checkout.session.cancelled": CheckoutSessionCancelledPayload;
}>;
