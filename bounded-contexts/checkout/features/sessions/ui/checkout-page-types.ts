import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";
import type { ReactNode } from "react";

export type CheckoutPaymentPreview = Readonly<{
  currency_code: string;
  amount: string;
  marketplace_checkout_fee: Readonly<{
    marketplace_checkout_fee_amount: string;
    marketplace_checkout_fee_reduction_amount: string;
    total_amount: string;
    processor_amount: string;
    quote_fingerprint: string;
  }>;
  payment_method_quotes: readonly Readonly<{
    payment_method_category: "card" | "bank-account" | "platform-credit";
    marketplace_checkout_fee_amount: string;
    total_amount: string;
  }>[];
  wallet_credit: Readonly<{
    requested_amount: string;
    applied_amount: string;
    external_amount: string;
  }>;
  can_start_payment?: boolean;
}>;

export const checkoutPaymentMethodCategories = ["card", "bank-account", "platform-credit"] as const;

export type CheckoutPaymentMethodCategory = (typeof checkoutPaymentMethodCategories)[number];

export type CheckoutSavedShippingAddress = Readonly<{
  shipping_address_id: string;
  label: string;
  recipient_name: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  phone: string | null;
  email: string | null;
  is_default: boolean;
}>;

export type CheckoutSavedPaymentInstrument = Readonly<{
  instrument_id: string;
  payment_method_category: "card" | "bank-account" | "platform-credit";
  provider: string;
  display_label: string;
  confirmation_experience: "trusted-payment-step" | "off-session-token";
  is_default: boolean;
  readiness: "ready" | "setup-required" | "removed";
}>;

export type CheckoutEditSection = "contact" | "delivery" | "shipping" | "payment";

export type GuestCheckoutContact = Readonly<{
  contactEmail: string;
  contactName: string | null;
}>;

export type CheckoutReservationUnavailableLine = Pick<
  CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number],
  "lineKey" | "sellerAccountId" | "inventoryItemId" | "itemTitle" | "productSummary" | "quantity"
>;

/** Normalized shipping-address form defaults, sourced from the session, a saved
 * address, or (for guests) the reconciled guest checkout contact. */
export type CheckoutAddressDefaults = Readonly<{
  shippingAddressId: string;
  name: string;
  company: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
}>;

export type CheckoutSessionPageProps = {
  session: CheckoutSessionRow;
  wallet?: { available_balance_amount: string; currency_code: string } | null;
  paymentPreview?: CheckoutPaymentPreview | null;
  selectedPaymentMethodCategory?: string;
  fulfillmentPreview?: CheckoutFulfillmentPreview | null;
  reservationUnavailableLines?: readonly CheckoutReservationUnavailableLine[];
  errorMessage?: string | null;
  reviewRefreshed?: boolean;
  paymentQuoteRequired?: boolean;
  isSubmitting?: boolean;
  savedShippingAddresses?: readonly CheckoutSavedShippingAddress[];
  savedCheckoutInstruments?: readonly CheckoutSavedPaymentInstrument[];
  guestCheckoutContact?: GuestCheckoutContact | null;
  canManageShippingAddresses?: boolean;
  canSavePaymentMethods?: boolean;
  isSignedInBuyer?: boolean;
  initialEditSection?: CheckoutEditSection | null;
  autoResumePaymentStart?: boolean;
  preparedPaymentEntry?: ReactNode;
};
