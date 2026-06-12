import { t } from "@chase-sets/localization";
import {
  guestSellCheckoutDefaultValues,
  type GuestSellCheckoutFieldErrors,
  type GuestSellCheckoutFormValues,
} from "../../../features/sell-list/ui/guest-sell-checkout-page";
import {
  signedInSellCheckoutDefaultValues,
  type SignedInSellCheckoutFieldErrors,
  type SignedInSellCheckoutFormValues,
  type SignedInSellCheckoutShipFromAddress,
} from "../../../features/sell-list/ui/signed-in-sell-checkout-page";

const unsupportedShipFromStates = new Set(["AA", "AE", "AP", "AS", "FM", "GU", "MH", "MP", "PR", "PW", "VI"]);

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function positiveIntegerValue(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && Number.isInteger(number) && number > 0 ? number : 0;
}

export function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export function normalizeQueryText(searchParams: URLSearchParams, name: string) {
  return searchParams.get(name)?.trim() ?? "";
}

export function guestDefaultValuesFromSearchParams(searchParams: URLSearchParams): GuestSellCheckoutFormValues {
  return {
    ...guestSellCheckoutDefaultValues,
    payoutState: normalizeQueryText(searchParams, "payoutState") || guestSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeQueryText(searchParams, "payoutEstimateState") || guestSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeQueryText(searchParams, "riskState") || guestSellCheckoutDefaultValues.riskState,
    labelState: normalizeQueryText(searchParams, "labelState") || guestSellCheckoutDefaultValues.labelState,
  };
}

export function signedInDefaultStateFromSearchParams(searchParams: URLSearchParams) {
  return {
    payoutState: normalizeQueryText(searchParams, "payoutState") || signedInSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeQueryText(searchParams, "payoutEstimateState") || signedInSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeQueryText(searchParams, "riskState") || signedInSellCheckoutDefaultValues.riskState,
    labelState: normalizeQueryText(searchParams, "labelState") || signedInSellCheckoutDefaultValues.labelState,
    sellerReadinessState:
      normalizeQueryText(searchParams, "sellerReadinessState") ||
      signedInSellCheckoutDefaultValues.sellerReadinessState,
  };
}

export function valuesFromFormData(formData: FormData): GuestSellCheckoutFormValues {
  return {
    sellerName: normalizeText(formData.get("sellerName")),
    email: normalizeText(formData.get("email")).toLowerCase(),
    phone: normalizeText(formData.get("phone")),
    shipFromName: normalizeText(formData.get("shipFromName")),
    company: normalizeText(formData.get("company")),
    shipFromLine1: normalizeText(formData.get("shipFromLine1")),
    shipFromLine2: normalizeText(formData.get("shipFromLine2")),
    shipFromCity: normalizeText(formData.get("shipFromCity")),
    shipFromState: normalizeText(formData.get("shipFromState")).toUpperCase(),
    shipFromPostalCode: normalizeText(formData.get("shipFromPostalCode")),
    shipFromCountry: (normalizeText(formData.get("shipFromCountry")) || "US").toUpperCase(),
    payoutHandoff: normalizeText(formData.get("payoutHandoff")),
    labelPreference: normalizeText(formData.get("labelPreference")),
    termsAccepted: formData.get("termsAccepted") === "accepted",
    payoutState: normalizeText(formData.get("payoutState")) || guestSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeText(formData.get("payoutEstimateState")) || guestSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeText(formData.get("riskState")) || guestSellCheckoutDefaultValues.riskState,
    labelState: normalizeText(formData.get("labelState")) || guestSellCheckoutDefaultValues.labelState,
  };
}

export function signedInValuesFromFormData(formData: FormData): SignedInSellCheckoutFormValues {
  return {
    sellerName: normalizeText(formData.get("sellerName")),
    email: normalizeText(formData.get("email")).toLowerCase(),
    phone: normalizeText(formData.get("phone")),
    shipFromAddressId: normalizeText(formData.get("shipFromAddressId")) || "__manual",
    shipFromName: normalizeText(formData.get("shipFromName")),
    company: normalizeText(formData.get("company")),
    shipFromLine1: normalizeText(formData.get("shipFromLine1")),
    shipFromLine2: normalizeText(formData.get("shipFromLine2")),
    shipFromCity: normalizeText(formData.get("shipFromCity")),
    shipFromState: normalizeText(formData.get("shipFromState")).toUpperCase(),
    shipFromPostalCode: normalizeText(formData.get("shipFromPostalCode")),
    shipFromCountry: (normalizeText(formData.get("shipFromCountry")) || "US").toUpperCase(),
    payoutMethod: normalizeText(formData.get("payoutMethod")) || signedInSellCheckoutDefaultValues.payoutMethod,
    labelPreference: normalizeText(formData.get("labelPreference")),
    termsAccepted: formData.get("termsAccepted") === "accepted",
    payoutState: normalizeText(formData.get("payoutState")) || signedInSellCheckoutDefaultValues.payoutState,
    payoutEstimateState:
      normalizeText(formData.get("payoutEstimateState")) || signedInSellCheckoutDefaultValues.payoutEstimateState,
    riskState: normalizeText(formData.get("riskState")) || signedInSellCheckoutDefaultValues.riskState,
    labelState: normalizeText(formData.get("labelState")) || signedInSellCheckoutDefaultValues.labelState,
    sellerReadinessState:
      normalizeText(formData.get("sellerReadinessState")) || signedInSellCheckoutDefaultValues.sellerReadinessState,
  };
}

export function applySelectedSavedShipFromAddress(
  values: SignedInSellCheckoutFormValues,
  savedShipFromAddresses: readonly SignedInSellCheckoutShipFromAddress[],
): SignedInSellCheckoutFormValues {
  if (values.shipFromAddressId === "__manual") {
    return values;
  }

  const savedAddress = savedShipFromAddresses.find((address) => address.shippingAddressId === values.shipFromAddressId);
  if (!savedAddress) {
    return values;
  }

  return {
    ...values,
    shipFromName: savedAddress.name,
    company: savedAddress.company,
    shipFromLine1: savedAddress.line1,
    shipFromLine2: savedAddress.line2,
    shipFromCity: savedAddress.city,
    shipFromState: savedAddress.state,
    shipFromPostalCode: savedAddress.postalCode,
    shipFromCountry: savedAddress.country,
  };
}

export function validateGuestSellCheckoutValues(values: GuestSellCheckoutFormValues): GuestSellCheckoutFieldErrors {
  const errors: GuestSellCheckoutFieldErrors = {};

  if (!values.sellerName) {
    errors.sellerName = t("checkout.routes.sellCheckoutSession.validation.seller.name.required");
  }
  if (!values.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.email = t("checkout.routes.sellCheckoutSession.validation.email.required");
  }
  if (!values.shipFromName) {
    errors.shipFromName = t("checkout.routes.sellCheckoutSession.validation.ship.from.name.required");
  }
  if (!values.shipFromLine1) {
    errors.shipFromLine1 = t("checkout.routes.sellCheckoutSession.validation.address.line1.required");
  }
  if (!values.shipFromCity) {
    errors.shipFromCity = t("checkout.routes.sellCheckoutSession.validation.city.required");
  }
  if (!values.shipFromState) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.required");
  } else if (unsupportedShipFromStates.has(values.shipFromState)) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.unsupported");
  }
  if (!values.shipFromPostalCode) {
    errors.shipFromPostalCode = t("checkout.routes.sellCheckoutSession.validation.postal.code.required");
  }
  if (values.shipFromCountry !== "US") {
    errors.shipFromCountry = t("checkout.routes.sellCheckoutSession.validation.country.unsupported");
  }
  if (values.payoutHandoff !== "create-account") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.handoff.required");
  }
  if (values.labelPreference !== "prepaid-label" && values.labelPreference !== "seller-label-later") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.preference.required");
  }
  if (!values.termsAccepted) {
    errors.termsAccepted = t("checkout.routes.sellCheckoutSession.validation.terms.required");
  }
  if (values.payoutState === "setup-required") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.setup.required");
  } else if (values.payoutState === "failed") {
    errors.payoutHandoff = t("checkout.routes.sellCheckoutSession.validation.payout.failed");
  }
  if (values.payoutEstimateState === "changed") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.payout.changed");
  }
  if (values.riskState === "hold") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.hold");
  } else if (values.riskState === "block") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.block");
  }
  if (values.labelState === "failed") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.failed");
  }

  return errors;
}

export function validateSignedInSellCheckoutValues(
  values: SignedInSellCheckoutFormValues,
): SignedInSellCheckoutFieldErrors {
  const errors: SignedInSellCheckoutFieldErrors = {};

  if (!values.sellerName) {
    errors.sellerName = t("checkout.routes.sellCheckoutSession.validation.seller.name.required");
  }
  if (!values.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) {
    errors.email = t("checkout.routes.sellCheckoutSession.validation.email.required");
  }
  if (!values.shipFromName) {
    errors.shipFromName = t("checkout.routes.sellCheckoutSession.validation.ship.from.name.required");
  }
  if (!values.shipFromLine1) {
    errors.shipFromLine1 = t("checkout.routes.sellCheckoutSession.validation.address.line1.required");
  }
  if (!values.shipFromCity) {
    errors.shipFromCity = t("checkout.routes.sellCheckoutSession.validation.city.required");
  }
  if (!values.shipFromState) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.state.required");
  } else if (unsupportedShipFromStates.has(values.shipFromState)) {
    errors.shipFromState = t("checkout.routes.sellCheckoutSession.validation.signed.in.state.unsupported");
  }
  if (!values.shipFromPostalCode) {
    errors.shipFromPostalCode = t("checkout.routes.sellCheckoutSession.validation.postal.code.required");
  }
  if (values.shipFromCountry !== "US") {
    errors.shipFromCountry = t("checkout.routes.sellCheckoutSession.validation.signed.in.country.unsupported");
  }
  if (values.payoutMethod !== "saved-payout" && values.payoutMethod !== "setup-payout") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.method.required");
  }
  if (values.labelPreference !== "prepaid-label" && values.labelPreference !== "seller-label-later") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.preference.required");
  }
  if (!values.termsAccepted) {
    errors.termsAccepted = t("checkout.routes.sellCheckoutSession.validation.terms.required");
  }
  if (values.payoutState === "setup-required") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.setup.required");
  } else if (values.payoutState === "failed") {
    errors.payoutMethod = t("checkout.routes.sellCheckoutSession.validation.payout.failed");
  }
  if (values.payoutEstimateState === "changed") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.payout.changed");
  }
  if (values.riskState === "hold") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.hold");
  } else if (values.riskState === "block") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.risk.block");
  }
  if (values.labelState === "failed") {
    errors.labelPreference = t("checkout.routes.sellCheckoutSession.validation.label.failed");
  }
  if (values.sellerReadinessState !== "ready") {
    errors.form = t("checkout.routes.sellCheckoutSession.validation.seller.readiness.failed");
  }

  return errors;
}

export function hasFieldErrors(errors: GuestSellCheckoutFieldErrors | SignedInSellCheckoutFieldErrors) {
  return Object.keys(errors).length > 0;
}
