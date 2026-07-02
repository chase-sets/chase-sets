import type { ReactNode } from "react";
import type { PaymentsPaymentDetail } from "../../api/contracts";

export type AccountPaymentOrderView = Readonly<{
  order_id: string;
  status: string;
  total_amount: string;
  seller_payout_amount: string;
}>;

export type GuestCheckoutClaimContext = Readonly<{
  accountId: string;
  paymentId: string;
  contactEmail: string;
  contactName: string;
}>;

export type GuestClaimActionData =
  | Readonly<{
      status: "claim-link-sent";
      token: string | null;
      expiresAt: string;
      displayName: string;
    }>
  | Readonly<{
      scope: "claim" | "retry";
      error: string;
    }>;

export type AccountPaymentPageProps = Readonly<{
  payment: PaymentsPaymentDetail;
  orders: readonly AccountPaymentOrderView[];
  isGuestCheckoutPayment: boolean;
  showSupportDetails: boolean;
  buyerEmail: string | null;
  retryActionError: string | null;
  feedbackPrompt: ReactNode;
  guestClaimSection: ReactNode;
}>;
