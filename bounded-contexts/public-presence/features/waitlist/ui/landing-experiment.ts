export const landingExperimentVariants = {
  sellerFirstV1: "seller_first_v1",
  sellerFirstV2: "seller_first_v2",
} as const;

export type LandingExperimentVariant = (typeof landingExperimentVariants)[keyof typeof landingExperimentVariants];
export type LandingIntent = "both" | "buy" | "sell";

const buyerIntentTokens = new Set(["buy", "buyer", "buyers", "buying", "collector", "collectors"]);

export function normalizeLandingIntent(value: string | null | undefined): LandingIntent | null {
  return value === "buy" || value === "sell" || value === "both" ? value : null;
}

function containsBuyerIntent(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => buyerIntentTokens.has(token));
}

export function resolveLandingIntent({
  intent,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  utmTerm,
}: Readonly<{
  intent?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
}>): LandingIntent {
  const explicitIntent = normalizeLandingIntent(intent);
  if (explicitIntent) {
    return explicitIntent;
  }

  return [utmSource, utmMedium, utmCampaign, utmContent, utmTerm].some(containsBuyerIntent) ? "buy" : "both";
}

export function landingExperimentVariantForIntent(intent: LandingIntent): LandingExperimentVariant {
  return intent === "buy" ? landingExperimentVariants.sellerFirstV2 : landingExperimentVariants.sellerFirstV1;
}

export function normalizeLandingExperimentVariant(value: string | null | undefined): LandingExperimentVariant {
  return value === landingExperimentVariants.sellerFirstV2
    ? landingExperimentVariants.sellerFirstV2
    : landingExperimentVariants.sellerFirstV1;
}
