import type { MarketplaceListingPriceTarget } from "@chase-sets/event-core/public-event-payloads/marketplace";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";

export type {
  AcceptedListingTargetPriceV1,
  MarketplaceListingPriceTarget,
  MarketplaceListingPriceDecision,
  NativeListingEligibilityV1,
} from "@chase-sets/event-core/public-event-payloads/marketplace";

export function listingPriceTargetKey(target: MarketplaceListingPriceTarget): string {
  if (target.kind === "native-marketplace") return "native-marketplace";
  if (target.kind !== "channel-connection" || !target.connectionId.trim()) {
    throw new Error("A channel price target requires a connection identity.");
  }
  return `channel-connection:${target.connectionId}`;
}

export function normalizeAcceptedListingPrice(amount: string, currencyCode: string) {
  const cents = tryMoneyToCents(amount.trim());
  const currency = currencyCode.trim().toUpperCase();
  if (cents === null || cents <= 0n || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error("Accepted listing price requires a positive decimal amount and a three-letter currency.");
  }
  return { priceAmount: centsToMoneyAmount(cents), priceCurrencyCode: currency };
}
