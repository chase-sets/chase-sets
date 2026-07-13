import type { ResolvedListingEvidenceRequirements } from "../../listing-evidence-policy/domain/policy";
import type { MarketplaceListingPhoto } from "./domain";
import { evaluateEvidenceCoverage, type EvidenceCoverageCode, type EvidenceCoverageResult } from "./evidence-coverage";
import type { ListingEvidenceRequirementSnapshot } from "./evidence-requirement-snapshot";

export type ListingEvidenceReadinessCode =
  | EvidenceCoverageCode
  | "listing-evidence-requirements-unavailable"
  | "seller-trust-requirement-unmet";

export type ListingEvidenceReadinessResult = Readonly<{
  ready: boolean;
  requirementHash: string | null;
  unmetCodes: readonly ListingEvidenceReadinessCode[];
  coverage: EvidenceCoverageResult | null;
}>;

export type ListingEvidenceSellerFacts = Readonly<{
  reviewCount: number;
  badgeKeys: readonly string[];
}>;

function sellerTrustRequirementIsMet(
  requirement: ResolvedListingEvidenceRequirements["sellerTrustRequirements"][number],
  seller: ListingEvidenceSellerFacts,
): boolean {
  return (
    seller.reviewCount >= requirement.minimumReviewCount ||
    requirement.acceptedBadgeKeys.some((badgeKey) => seller.badgeKeys.includes(badgeKey))
  );
}

export function evaluateListingEvidenceReadiness(
  input: Readonly<{
    snapshot: ListingEvidenceRequirementSnapshot | null;
    evidence: readonly MarketplaceListingPhoto[];
    seller: ListingEvidenceSellerFacts;
    now?: string | null;
  }>,
): ListingEvidenceReadinessResult {
  if (!input.snapshot) {
    return {
      ready: false,
      requirementHash: null,
      unmetCodes: ["listing-evidence-requirements-unavailable"],
      coverage: null,
    };
  }

  const coverage = evaluateEvidenceCoverage(input.snapshot.requirements, input.evidence, { now: input.now });
  const unmetCodes = new Set<ListingEvidenceReadinessCode>(coverage.unmetCodes);
  if (
    input.snapshot.requirements.sellerTrustRequirements.some(
      (requirement) => !sellerTrustRequirementIsMet(requirement, input.seller),
    )
  ) {
    unmetCodes.add("seller-trust-requirement-unmet");
  }

  return {
    ready: unmetCodes.size === 0,
    requirementHash: input.snapshot.requirementHash,
    unmetCodes: [...unmetCodes],
    coverage,
  };
}
