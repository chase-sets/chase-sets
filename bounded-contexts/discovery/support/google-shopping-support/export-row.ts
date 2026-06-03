import { createHash } from "node:crypto";

export type GoogleShoppingEligibilityStatus = "eligible" | "excluded";

export type GoogleShoppingExclusionReason =
  | "listing-not-active"
  | "seller-unavailable"
  | "missing-title"
  | "missing-description"
  | "missing-image"
  | "missing-price"
  | "missing-condition"
  | "missing-shipping-policy"
  | "missing-returns-policy"
  | "not-crawlable";

export type GoogleShoppingFeedRowInput = Readonly<{
  listingId: string;
  listingStatus: string;
  sellerListingAvailabilityStatus: string;
  accountId: string;
  catalogItemId: string;
  productId: string;
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  priceAmount: string | null;
  condition: string | null;
  shippingPolicyReady: boolean;
  returnsPolicyReady: boolean;
  crawlable: boolean;
}>;

export type GoogleShoppingPayloadInput = Readonly<{
  offerId: string;
  title: string;
  description: string;
  link: string;
  imageLink: string;
  priceAmount: string;
  currencyCode: string;
  availability: "in stock" | "out of stock";
  condition: string;
  externalSellerId: string;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
}>;

export function buildGoogleShoppingRowId(listingId: string) {
  return `google-shopping:listing:${listingId}`;
}

export function buildGoogleShoppingMerchantOfferId(listingId: string) {
  return `cs-listing-${listingId}`;
}

export function buildGoogleShoppingExternalSellerId(accountId: string) {
  return `cs-account-${accountId}`;
}

export function evaluateGoogleShoppingEligibility(
  input: GoogleShoppingFeedRowInput,
): Readonly<{ status: GoogleShoppingEligibilityStatus; reasons: readonly GoogleShoppingExclusionReason[] }> {
  const reasons: GoogleShoppingExclusionReason[] = [];

  if (input.listingStatus !== "active") {
    reasons.push("listing-not-active");
  }
  if (input.sellerListingAvailabilityStatus !== "available") {
    reasons.push("seller-unavailable");
  }
  if (!input.title?.trim()) {
    reasons.push("missing-title");
  }
  if (!input.description?.trim()) {
    reasons.push("missing-description");
  }
  if (!input.imageUrl?.trim()) {
    reasons.push("missing-image");
  }
  if (!isPositiveMoneyAmount(input.priceAmount)) {
    reasons.push("missing-price");
  }
  if (!input.condition?.trim()) {
    reasons.push("missing-condition");
  }
  if (!input.shippingPolicyReady) {
    reasons.push("missing-shipping-policy");
  }
  if (!input.returnsPolicyReady) {
    reasons.push("missing-returns-policy");
  }
  if (!input.crawlable || !input.canonicalUrl?.trim()) {
    reasons.push("not-crawlable");
  }

  return {
    status: reasons.length === 0 ? "eligible" : "excluded",
    reasons,
  };
}

export function hashGoogleShoppingPayload(payload: GoogleShoppingPayloadInput) {
  return createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

function isPositiveMoneyAmount(value: string | null) {
  if (!value?.trim()) {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
