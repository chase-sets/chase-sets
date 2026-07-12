import { formatMoney, t } from "@chase-sets/localization";
import type { CheckoutFulfillmentPreview, CheckoutSessionRow } from "../../../support/request-support/api-client";
import {
  checkoutPaymentMethodCategories,
  type CheckoutAddressDefaults,
  type CheckoutPaymentMethodCategory,
  type CheckoutReservationUnavailableLine,
} from "./checkout-page-types";

export function deliveryWindowLabel(group: CheckoutFulfillmentPreview["sellerGroups"][number]) {
  return `${group.deliveryEstimate.earliestDate} - ${group.deliveryEstimate.latestDate}`;
}

export function addressIsComplete(
  address: Readonly<{
    name: string;
    line1: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>,
) {
  return [address.name, address.line1, address.city, address.state, address.postalCode, address.country].every(
    (value) => value.trim().length > 0,
  );
}

export function addressSummary(
  address: Readonly<{
    line1: string;
    line2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }>,
) {
  const region = [address.state, address.postalCode].filter((value) => value.trim().length > 0).join(" ");
  const locality = [address.city, region].filter((value) => value.trim().length > 0).join(", ");
  return [address.line1, address.line2, locality, address.country]
    .filter((value) => value.trim().length > 0)
    .join(", ");
}

export function isCheckoutPaymentMethodCategory(value: string): value is CheckoutPaymentMethodCategory {
  return checkoutPaymentMethodCategories.includes(value as CheckoutPaymentMethodCategory);
}

export function paymentMethodCategoryLabel(category: CheckoutPaymentMethodCategory) {
  switch (category) {
    case "bank-account":
      return t("checkout.features.sessions.ui.checkoutPage.bank.account");
    case "platform-credit":
      return t("checkout.features.sessions.ui.checkoutPage.platform.credit.only");
    default:
      return t("checkout.features.sessions.ui.checkoutPage.card");
  }
}

export function contactSupportingText(phone: string) {
  return phone.trim().length > 0
    ? t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting.phone", { phone })
    : t("checkout.features.sessions.ui.checkoutPage.contact.row.supporting");
}

export function normalizedAddressSignature(
  address: Readonly<{
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
  }>,
) {
  return JSON.stringify({
    name: address.name.trim(),
    company: address.company.trim(),
    line1: address.line1.trim(),
    line2: address.line2.trim(),
    city: address.city.trim(),
    state: address.state.trim().toUpperCase(),
    postalCode: address.postalCode.trim(),
    country: address.country.trim().toUpperCase(),
    phone: address.phone.trim(),
    email: address.email.trim().toLowerCase(),
  });
}

export function firstSellerGroup(preview: CheckoutFulfillmentPreview | null) {
  return preview?.sellerGroups[0] ?? null;
}

export function formatMoneyOrPending(value: string | null | undefined) {
  return value ? formatMoney(value, "USD") : t("checkout.features.sessions.ui.checkoutPage.pending");
}

export function formatReservationTime(msRemaining: number) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function reservationUnavailableItemsLabel(lines: readonly CheckoutReservationUnavailableLine[]) {
  return [...new Set(lines.map((line) => line.itemTitle).filter((title) => title.trim().length > 0))]
    .slice(0, 3)
    .join(", ");
}

export function previewLineForSessionLine(
  line: CheckoutSessionRow["lines"][number],
  previewLines: readonly CheckoutFulfillmentPreview["sellerGroups"][number]["lines"][number][],
) {
  return (
    previewLines.find((previewLine) => line.cartLineId && previewLine.lineKey === line.cartLineId) ??
    previewLines.find((previewLine) => line.listingId && previewLine.listingId === line.listingId) ??
    previewLines.find((previewLine) => previewLine.productId === line.productId) ??
    null
  );
}

export function shippingOptionLabel(option: CheckoutSessionRow["shipping_option"]) {
  switch (option) {
    case "expedited":
      return t("checkout.features.sessions.ui.checkoutPage.expedited");
    case "priority":
      return t("checkout.features.sessions.ui.checkoutPage.priority");
    default:
      return t("checkout.features.sessions.ui.checkoutPage.standard.insured");
  }
}

/** Builds the shipping-address form defaults for the checkout form: the
 * session's own shipping address takes priority, then the buyer's default
 * saved address, then (for guests) the reconciled guest checkout contact. */
export function buildCheckoutAddressDefaults(input: {
  session: CheckoutSessionRow;
  defaultSavedAddress: {
    shipping_address_id: string;
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
  } | null;
  guestBuyCheckout: boolean;
  guestCheckoutContact: Readonly<{ contactEmail: string; contactName: string | null }> | null;
}): CheckoutAddressDefaults {
  const { session, defaultSavedAddress, guestBuyCheckout, guestCheckoutContact } = input;

  if (session.shipping_address) {
    return {
      shippingAddressId: session.shipping_address.shippingAddressId ?? "__manual",
      name: session.shipping_address.name,
      company: session.shipping_address.company ?? "",
      line1: session.shipping_address.line1,
      line2: session.shipping_address.line2 ?? "",
      city: session.shipping_address.city,
      state: session.shipping_address.state,
      postalCode: session.shipping_address.postalCode,
      country: session.shipping_address.country,
      phone: session.shipping_address.phone ?? "",
      email: session.shipping_address.email ?? "",
    };
  }

  if (defaultSavedAddress) {
    return {
      shippingAddressId: defaultSavedAddress.shipping_address_id,
      name: defaultSavedAddress.recipient_name,
      company: defaultSavedAddress.company ?? "",
      line1: defaultSavedAddress.line1,
      line2: defaultSavedAddress.line2 ?? "",
      city: defaultSavedAddress.city,
      state: defaultSavedAddress.state,
      postalCode: defaultSavedAddress.postal_code,
      country: defaultSavedAddress.country,
      phone: defaultSavedAddress.phone ?? "",
      email: defaultSavedAddress.email ?? "",
    };
  }

  return {
    shippingAddressId: "__manual",
    name: guestBuyCheckout ? (guestCheckoutContact?.contactName ?? "") : "",
    company: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    country: "US",
    phone: "",
    email: guestBuyCheckout ? (guestCheckoutContact?.contactEmail ?? "") : "",
  };
}
