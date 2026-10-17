export type MarketplaceOfferAbuseControlCode = "offer_daily_submission_cap_reached";

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
}>;

export const DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY = {
  policyVersion: "marketplace-offer-abuse-controls-v2",
  buyerDailySubmissionCap: 25,
} as const satisfies MarketplaceOfferAbusePolicy;

export type MarketplaceOfferSubmissionGuardInput = Readonly<{
  policy?: MarketplaceOfferAbusePolicy;
  buyerDailySubmissionCount: number;
}>;

export function assertOfferSubmissionAllowed(input: MarketplaceOfferSubmissionGuardInput) {
  const policy = input.policy ?? DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY;
  if (input.buyerDailySubmissionCount >= policy.buyerDailySubmissionCap) {
    throw new MarketplaceOfferAbuseControlError(
      "offer_daily_submission_cap_reached",
      `You have reached the daily offer submission limit of ${policy.buyerDailySubmissionCap}.`,
      { policyVersion: policy.policyVersion, limit: policy.buyerDailySubmissionCap },
    );
  }
}
