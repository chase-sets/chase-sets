import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";

export type MarketplaceListingPriceTarget =
  | Readonly<{ kind: "native-marketplace" }>
  | Readonly<{ kind: "channel-connection"; connectionId: string }>;

export type MarketplaceListingPriceDecision =
  | Readonly<{ kind: "seller-reference" }>
  | Readonly<{
      kind: "pricing-evaluation";
      evaluationId: string;
      evaluationRevision: string;
      basePriceRevision: number;
      standingAuthorizationId: string;
      standingAuthorizationRevision: string;
    }>;

export type AcceptedListingTargetPriceV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  listingId: string;
  target: MarketplaceListingPriceTarget;
  priceAmount: string;
  priceCurrencyCode: string;
  targetPriceRevision: number;
  listingRevision: number;
  acceptedByUserId: string;
  acceptedAt: string;
  sourceEventId: string;
  decision: MarketplaceListingPriceDecision;
  connectionAuthority: Readonly<{
    connectionId: string;
    providerKey: string;
    environment: "sandbox" | "production";
    identityRevision: number;
  }> | null;
}>;

export function listingPriceTargetKey(target: MarketplaceListingPriceTarget): string {
  return target.kind === "native-marketplace" ? "native-marketplace" : `channel-connection:${target.connectionId}`;
}

export function normalizeAcceptedListingPrice(amount: string, currencyCode: string) {
  const cents = tryMoneyToCents(amount.trim());
  if (cents === null || cents <= 0n) throw new Error("Accepted listing price must be greater than zero.");
  const currency = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Accepted listing currency must be ISO-4217.");
  return { priceAmount: centsToMoneyAmount(cents), priceCurrencyCode: currency };
}
