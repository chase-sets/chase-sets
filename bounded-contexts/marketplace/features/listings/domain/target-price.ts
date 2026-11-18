import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";

import type { MarketplaceListingPriceTarget } from "@chase-sets/event-core/public-event-payloads";
export type {
  MarketplaceListingPriceTarget,
  MarketplaceListingPriceDecision,
  AcceptedListingTargetPriceV1,
} from "@chase-sets/event-core/public-event-payloads";

export function listingPriceTargetKey(target: MarketplaceListingPriceTarget): string {
  return target.kind === "native-marketplace" ? "native-marketplace" : `channel-connection:${target.connectionId}`;
}

export function normalizeAcceptedListingPrice(amount: string, currencyCode: string) {
  const cents = tryMoneyToCents(amount.trim());
  if (cents === null || cents <= 0n) throw new Error("Accepted listing price must be greater than zero.");
  const currency = currencyCode.trim().toUpperCase();
  if (!Intl.supportedValuesOf("currency").includes(currency))
    throw new Error("Accepted listing currency must be ISO-4217.");
  return { priceAmount: centsToMoneyAmount(cents), priceCurrencyCode: currency };
}
