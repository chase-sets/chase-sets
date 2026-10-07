import type { EvidenceCoverageCode } from "@chase-sets/marketplace/server";

export type { EvidenceCoverageCode, MarketplaceListingEvidenceCoverage } from "@chase-sets/marketplace/server";

export function evidenceCoverageCodeLocaleKey(code: EvidenceCoverageCode): string {
  return `marketplace.features.listings.evidenceCoverage.${code}`;
}
