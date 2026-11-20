import { createPaymentsRequestApiClient } from "./api-client";
import { isClaimablePayment } from "../../features/payments/ui/account-payment/account-payment-display";

export async function readGuestPaymentClaimability(
  request: Request,
  paymentId: string,
): Promise<Readonly<{ claimable: boolean }>> {
  const payment = await createPaymentsRequestApiClient(request).getAccountPayment(paymentId);
  const result = { claimable: isClaimablePayment(payment) };
  for (const key of [...Object.getOwnPropertySymbols(payment), "commandReceipt"]) {
    const descriptor = Object.getOwnPropertyDescriptor(payment, key);
    if (descriptor) Object.defineProperty(result, key, descriptor);
  }
  return result;
}
