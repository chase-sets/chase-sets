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
      scope: "claim";
      error: string;
    }>;

export type GuestPaymentClaimLoaderData = Readonly<{
  paymentId: string;
  claimable: boolean;
  guestClaimContext: GuestCheckoutClaimContext | null;
}>;
