// Deployable-facing payment-entry surface. Checkout routes compose this
// Payments-owned browser UI without moving provider behavior into Checkout.
export { StripeConfirmationCard } from "../../features/payments/ui/account-payment/stripe-confirmation-card";
export type { PaymentElementDefaultValues } from "../../features/payments/ui/account-payment/account-payment-contracts";
export type { PaymentsPaymentDetail } from "../../features/payments/api/contracts";
