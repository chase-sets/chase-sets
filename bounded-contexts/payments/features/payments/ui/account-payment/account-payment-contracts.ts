import type { ReactNode } from "react";
import type { PaymentsPaymentDetail } from "../../api/contracts";

export type AccountPaymentOrderView = Readonly<{
  order_id: string;
  status: string;
  total_amount: string;
  seller_payout_amount: string;
  payment_deadline_at: string | null;
}>;

export type PaymentElementDefaultValues = Readonly<{
  billingDetails: Readonly<{
    email: string;
    name?: string;
    address?: Readonly<{
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    }>;
  }>;
}>;

export type AccountPaymentPageProps = Readonly<{
  payment: PaymentsPaymentDetail;
  orders: readonly AccountPaymentOrderView[];
  isGuestCheckoutPayment: boolean;
  showSupportDetails: boolean;
  paymentElementDefaultValues: PaymentElementDefaultValues | null;
  retryActionError: string | null;
  guestClaimSection: ReactNode;
}>;
