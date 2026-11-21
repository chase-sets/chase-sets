/** Auth's claim context: the contact stays null until a checkout binds one. */
export type GuestCheckoutClaimContext = Readonly<{
  accountId: string;
  paymentId: string;
  contactEmail: string | null;
  contactName: string | null;
}>;

/** A contact Auth reports bound: both its email and its name are present. Only this can be claimed. */
export type BoundGuestClaimContact = Readonly<{
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
  /** Null when the payment is not claimable yet, the contact is unbound, or Auth refused the read. */
  guestClaimContact: BoundGuestClaimContact | null;
}>;
