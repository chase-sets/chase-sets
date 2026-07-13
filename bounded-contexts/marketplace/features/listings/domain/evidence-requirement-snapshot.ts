import { createHash } from "node:crypto";
import type {
  ListingEvidencePolicyEvaluation,
  ResolvedListingEvidenceRequirements,
} from "../../listing-evidence-policy/domain/policy";

export type ListingEvidenceRequirementSnapshot = Readonly<{
  policyId: string | null;
  policyVersion: number | null;
  policyHash: string;
  evaluatedAt: string;
  requirementHash: string;
  matchedRuleIds: readonly string[];
  explanationCodes: readonly string[];
  requirements: ResolvedListingEvidenceRequirements;
}>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function listingEvidenceRequirementHash(
  evaluation: Pick<
    ListingEvidencePolicyEvaluation,
    "policyId" | "policyVersion" | "policyHash" | "matchedRuleIds" | "requirements" | "explanationCodes"
  >,
): string {
  return contentHash({
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    policyHash: evaluation.policyHash,
    matchedRuleIds: evaluation.matchedRuleIds,
    requirements: evaluation.requirements,
    explanationCodes: evaluation.explanationCodes,
  });
}

export function createListingEvidenceRequirementSnapshot(
  evaluation: ListingEvidencePolicyEvaluation,
  evaluatedAt: string,
): ListingEvidenceRequirementSnapshot {
  return {
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    policyHash: evaluation.policyHash,
    evaluatedAt,
    requirementHash: listingEvidenceRequirementHash(evaluation),
    matchedRuleIds: [...evaluation.matchedRuleIds],
    explanationCodes: [...evaluation.explanationCodes],
    requirements: evaluation.requirements,
  };
}
