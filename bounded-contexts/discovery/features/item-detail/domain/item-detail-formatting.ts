import { formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import type { DiscoveryMarketListing, DiscoveryOffer } from "../../../support/client-support/contracts";

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object" && "values" in value) {
    const values = (value as { values?: Record<string, string> }).values ?? {};
    return values.en ?? Object.values(values)[0] ?? "-";
  }

  return JSON.stringify(value);
}

export function formatReferenceAttributes(attributes: unknown): Array<{ key: string; value: string }> {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    return [];
  }

  return Object.entries(attributes).map(([key, value]) => ({ key, value: formatFieldValue(value) }));
}

export function formatRelationshipType(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function formatUpdatedAt(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function formatMoney(value: string | null): string {
  return value ? formatMoneyDisplay(value, "USD") : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}

function toFiniteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function getListingAvailableQuantity(
  listing: Pick<DiscoveryMarketListing, "visible_quantity" | "quantity_cap">,
): number {
  return toFiniteNumber(listing.visible_quantity) ?? toFiniteNumber(listing.quantity_cap) ?? 0;
}

export function formatListingAvailability(
  listing: Pick<DiscoveryMarketListing, "visible_quantity" | "quantity_cap">,
): string {
  const availableQuantity = getListingAvailableQuantity(listing);

  return availableQuantity > 0
    ? t("discovery.features.itemDetail.ui.itemDetailPage.listing.available.count", {
        count: availableQuantity,
      })
    : t("discovery.features.itemDetail.ui.itemDetailPage.unavailable");
}

export function formatOfferRequestedQuantity(offer: Pick<DiscoveryOffer, "quantity_requested">): string {
  return t("discovery.features.itemDetail.ui.itemDetailPage.offer.requested.count", {
    count: offer.quantity_requested,
  });
}

export function formatListingPurchaseLimit(
  listing: Pick<DiscoveryMarketListing, "max_units_per_order" | "max_units_per_day" | "max_units_per_customer_account">,
): string | null {
  if (listing.max_units_per_customer_account) {
    return `Limit ${listing.max_units_per_customer_account} per customer`;
  }
  if (listing.max_units_per_day) {
    return `Limit ${listing.max_units_per_day} per day`;
  }
  if (listing.max_units_per_order) {
    return `Limit ${listing.max_units_per_order} per order`;
  }
  return null;
}

export function formatCompactProductSummary(
  summary: string | null | undefined,
  selections: readonly { label: string; value: string }[],
  fallback: string,
): string {
  const selectionSummary = selections
    .map((selection) => selection.value.trim())
    .filter(Boolean)
    .join(" · ");
  const source = selectionSummary || summary?.trim();

  return (source || fallback)
    .replace(/\s*\/\s*/g, " · ")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s*·\s*/g, " · ");
}

export function parseRating(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

export function formatListingCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.listing.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.listing.count.plural",
    { count },
  );
}

export function formatSellerCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.seller.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.seller.count.plural",
    { count },
  );
}

export function formatOfferCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.offer.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.offer.count.plural",
    { count },
  );
}

export function formatBuyerCount(count: number): string {
  return t(
    count === 1
      ? "discovery.features.itemDetail.ui.itemDetailPage.buyer.count.singular"
      : "discovery.features.itemDetail.ui.itemDetailPage.buyer.count.plural",
    { count },
  );
}
