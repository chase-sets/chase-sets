/** A deferred Checkout intent is already confirmed server-side. It never exposes a client secret. */
export function isDeferredCheckoutPayment(
  payment: Readonly<{
    source_context: string | null;
    processor_payment_kind: string | null;
    processor_client_secret: string | null;
    saved_checkout_instrument_id: string | null;
  }>,
) {
  return (
    payment.source_context === "checkout" &&
    payment.processor_payment_kind === "payment-intent" &&
    !payment.processor_client_secret &&
    !payment.saved_checkout_instrument_id
  );
}
