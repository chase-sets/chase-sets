export type MarketplaceOfferAbuseControlCode =
  | "offer_daily_submission_cap_reached"
  | "offer_listing_submission_cap_reached"
  | "offer_price_floor_not_met"
  | "offer_lowball_cooldown"
  | "offer_muted_by_sellers";

export class MarketplaceOfferAbuseControlError extends Error {
  public constructor(
    public readonly code: MarketplaceOfferAbuseControlCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MarketplaceOfferAbuseControlError";
  }
}

export type MarketplaceOfferAbusePolicy = Readonly<{
  policyVersion: string;
  buyerDailySubmissionCap: number;
  buyerListingDailySubmissionCap: number;
  minimumOfferToListingPriceBps: number;
  lowballDeclineCountForCooldown: number;
  lowballCooldownWindowMs: number;
}>;

export const DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY = {
  policyVersion: "marketplace-offer-abuse-controls-v1",
  buyerDailySubmissionCap: 25,
  buyerListingDailySubmissionCap: 3,
  minimumOfferToListingPriceBps: 5_000,
  lowballDeclineCountForCooldown: 2,
  lowballCooldownWindowMs: 7 * 24 * 60 * 60 * 1000,
} as const satisfies MarketplaceOfferAbusePolicy;

export type MarketplaceOfferListingSubmissionGuard = Readonly<{
  listingId: string;
  sellerAccountId: string;
  listingPriceAmount: string;
  buyerListingDailyOfferCount: number;
  mutedAt: string | null;
  lowballCooldownUntil: string | null;
  lastLowballDeclinedAmount: string | null;
}>;

export type MarketplaceOfferSubmissionGuardInput = Readonly<{
  policy?: MarketplaceOfferAbusePolicy;
  now: Date;
  buyerDailySubmissionCount: number;
  offerPriceAmount: string;
  listingGuards: readonly MarketplaceOfferListingSubmissionGuard[];
}>;

export function parseMoneyCents(amount: string): bigint {
  const normalized = amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Money amount must be a valid decimal.");
  }
  const [dollars, cents = ""] = normalized.split(".");
  return BigInt(dollars) * 100n + BigInt(cents.padEnd(2, "0"));
}

export function formatMoneyCents(cents: bigint): string {
  const dollars = cents / 100n;
  const remainder = cents % 100n;
  return `${dollars}.${remainder.toString().padStart(2, "0")}`;
}

export function requiredOfferFloorAmount(listingPriceAmount: string, minimumOfferToListingPriceBps: number): string {
  const listingCents = parseMoneyCents(listingPriceAmount);
  const numerator = listingCents * BigInt(minimumOfferToListingPriceBps);
  const floorCents = (numerator + 9_999n) / 10_000n;
  return formatMoneyCents(floorCents);
}

export function offerMeetsListingFloor(
  offerPriceAmount: string,
  listingPriceAmount: string,
  minimumOfferToListingPriceBps: number,
) {
  return (
    parseMoneyCents(offerPriceAmount) >=
    parseMoneyCents(requiredOfferFloorAmount(listingPriceAmount, minimumOfferToListingPriceBps))
  );
}

function activeCooldown(now: Date, cooldownUntil: string | null) {
  if (!cooldownUntil) {
    return false;
  }

  const parsed = new Date(cooldownUntil);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime();
}

export function assertOfferSubmissionAllowed(input: MarketplaceOfferSubmissionGuardInput) {
  const policy = input.policy ?? DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY;
  if (input.buyerDailySubmissionCount >= policy.buyerDailySubmissionCap) {
    throw new MarketplaceOfferAbuseControlError(
      "offer_daily_submission_cap_reached",
      `You have reached the daily offer submission limit of ${policy.buyerDailySubmissionCap}.`,
      { policyVersion: policy.policyVersion, limit: policy.buyerDailySubmissionCap },
    );
  }

  if (input.listingGuards.length === 0) {
    return;
  }

  const unmutedListings = input.listingGuards.filter((listing) => !listing.mutedAt);
  if (unmutedListings.length === 0) {
    throw new MarketplaceOfferAbuseControlError(
      "offer_muted_by_sellers",
      "Your offers are muted by the current matching sellers.",
      { policyVersion: policy.policyVersion },
    );
  }

  const cappedListing = unmutedListings.find(
    (listing) => listing.buyerListingDailyOfferCount >= policy.buyerListingDailySubmissionCap,
  );
  if (cappedListing) {
    throw new MarketplaceOfferAbuseControlError(
      "offer_listing_submission_cap_reached",
      `You have reached the daily offer limit for this listing.`,
      {
        policyVersion: policy.policyVersion,
        listingId: cappedListing.listingId,
        limit: policy.buyerListingDailySubmissionCap,
      },
    );
  }

  const floorBlockedListings = unmutedListings.filter(
    (listing) =>
      !offerMeetsListingFloor(input.offerPriceAmount, listing.listingPriceAmount, policy.minimumOfferToListingPriceBps),
  );
  if (floorBlockedListings.length === unmutedListings.length) {
    const minimumFloor = floorBlockedListings.reduce<bigint | null>((current, listing) => {
      const cents = parseMoneyCents(
        requiredOfferFloorAmount(listing.listingPriceAmount, policy.minimumOfferToListingPriceBps),
      );
      return current === null || cents < current ? cents : current;
    }, null);
    throw new MarketplaceOfferAbuseControlError(
      "offer_price_floor_not_met",
      `Offer must be at least $${formatMoneyCents(minimumFloor ?? 0n)} for current listings.`,
      {
        policyVersion: policy.policyVersion,
        minimumOfferAmount: formatMoneyCents(minimumFloor ?? 0n),
        minimumOfferToListingPriceBps: policy.minimumOfferToListingPriceBps,
      },
    );
  }

  const cooldownBlockedListings = unmutedListings.filter(
    (listing) =>
      activeCooldown(input.now, listing.lowballCooldownUntil) &&
      listing.lastLowballDeclinedAmount !== null &&
      parseMoneyCents(input.offerPriceAmount) < parseMoneyCents(listing.lastLowballDeclinedAmount),
  );
  if (cooldownBlockedListings.length > 0) {
    throw new MarketplaceOfferAbuseControlError(
      "offer_lowball_cooldown",
      "This seller declined repeated low offers. Raise your offer before trying again.",
      {
        policyVersion: policy.policyVersion,
        cooldownUntil: cooldownBlockedListings[0]?.lowballCooldownUntil ?? null,
      },
    );
  }
}
