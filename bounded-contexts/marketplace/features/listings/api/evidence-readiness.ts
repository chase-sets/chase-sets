import { evidenceCoverageCodeLocaleKey, type EvidenceCoverageCode } from "../domain/evidence-coverage";
import { toPublicListingGallery } from "../domain/evidence-gallery";
import type { MarketplaceListingPhoto } from "../domain/domain";
import type { ListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import type {
  ListingEvidenceReadinessCode,
  ListingEvidenceReadinessResult,
} from "../domain/listing-evidence-readiness";
import type { MarketplaceListingEvidenceReadiness } from "../ui/contracts";

function readinessLocaleKey(code: ListingEvidenceReadinessCode): string {
  switch (code) {
    case "listing-evidence-requirements-unavailable":
      return "marketplace.features.listings.evidenceReadiness.requirements-unavailable";
    case "seller-trust-requirement-unmet":
      return "marketplace.features.listings.evidenceReadiness.seller-trust-requirement-unmet";
    default:
      return evidenceCoverageCodeLocaleKey(code);
  }
}

/**
 * Projects the policy result and typed Listing Photos into the seller-facing
 * readiness read model. Domain evaluation stays in the canonical policy and
 * coverage functions; this layer only adds concrete navigation metadata.
 */
export function buildMarketplaceListingEvidenceReadiness(
  snapshot: ListingEvidenceRequirementSnapshot,
  evidence: readonly MarketplaceListingPhoto[],
  readiness: ListingEvidenceReadinessResult,
): MarketplaceListingEvidenceReadiness {
  if (!readiness.coverage) {
    throw new Error("Listing evidence coverage is unavailable.");
  }
  const coverage = readiness.coverage;

  return {
    ready: readiness.ready,
    policy: {
      policyId: snapshot.policyId,
      policyVersion: snapshot.policyVersion,
      policyHash: snapshot.policyHash,
      requirementHash: snapshot.requirementHash,
      evaluatedAt: snapshot.evaluatedAt,
      explanationCodes: snapshot.explanationCodes,
    },
    requirements: snapshot.requirements,
    coverage,
    nextActions: readiness.unmetCodes.map((code) => ({
      code,
      localeKey: readinessLocaleKey(code),
      slotIds: coverage.slots
        .filter((slot) => slot.unmetCode === (code as EvidenceCoverageCode))
        .map((slot) => slot.slotId),
    })),
    publicGallery: toPublicListingGallery(evidence),
  };
}
