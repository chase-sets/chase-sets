import type { createPaymentsRequestApiClient, PaymentsCheckoutStatus } from "@chase-sets/payments/server";

/** The checkout's payment preview: the fee quote per payment method and the wallet credit applied. */
export type CheckoutPaymentPreviewStatus = PaymentsCheckoutStatus;

type CheckoutPaymentPreviewReader = Pick<ReturnType<typeof createPaymentsRequestApiClient>, "previewCheckoutStatus">;

/**
 * Reads the preview from Payments, which quotes it from the fee policy Commercial Terms resolves and
 * checks Pay now's quote fingerprint against the same policy. A read that fails gives no preview,
 * which keeps the page's totals notice instead of offering a quote Payments may refuse.
 */
export async function readCheckoutPaymentPreviewStatus(
  payments: CheckoutPaymentPreviewReader,
  params: Readonly<{
    orderIds: readonly string[];
    amount: string;
    currencyCode: string;
    requestedBalanceCreditAmount: string;
    paymentMethodCategory: string;
  }>,
): Promise<CheckoutPaymentPreviewStatus | null> {
  try {
    const status = await payments.previewCheckoutStatus({
      amount: params.amount,
      currencyCode: params.currencyCode,
      requestedBalanceCreditAmount: params.requestedBalanceCreditAmount,
      paymentMethodCategory: params.paymentMethodCategory,
    });
    return { ...status, order_ids: params.orderIds };
  } catch {
    return null;
  }
}
