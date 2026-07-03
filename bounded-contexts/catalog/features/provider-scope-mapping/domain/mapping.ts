import { createHash } from "node:crypto";
import type { JsonObject } from "@chase-sets/primitives/json";
import { assert } from "../../../support/runtime-support/common";

export type ProviderScopeMappingReviewStatus = "proposed" | "accepted" | "auto-accepted" | "rejected" | "revoked";

export type ProviderScopeMappingConfidenceTier = "exact" | "high" | "candidate" | "generated" | "manual";

export type ProviderScopeMappingLanguageCoordinates = Readonly<{
  languageCode: string | null;
  providerLanguageCode: string | null;
  providerLanguageId: string | null;
  providerLocale: string | null;
  providerLanguageName: string | null;
}>;

export type ProviderScopeMappingCoordinates = Readonly<{
  productLineId: string | null;
  seriesId: string | null;
  setId: string | null;
  setName: string | null;
  language: ProviderScopeMappingLanguageCoordinates;
}>;

export type ProviderScopeMappingIdentity = Readonly<{
  scopeRecordId: string;
  providerKey: string;
  unitKey: string;
}>;

export type ProviderScopeMappingProvenance = Readonly<{
  source: string;
  sourceId: string | null;
  sourceProfileKey: string | null;
  sourceProfileVersion: string | null;
  mappingFingerprint: string | null;
}>;

export type ProviderScopeMappingCandidate = Readonly<
  ProviderScopeMappingIdentity & {
    mappingId: string;
    coordinates: ProviderScopeMappingCoordinates;
    confidence: ProviderScopeMappingConfidenceTier;
    reviewStatus: ProviderScopeMappingReviewStatus;
    provenance: ProviderScopeMappingProvenance;
    evidence: JsonObject;
  }
>;

export type BuildProviderScopeMappingCandidateInput = Readonly<{
  scopeRecordId: string;
  providerKey: string;
  unitKey: string;
  coordinates: Readonly<{
    productLineId?: string | null;
    seriesId?: string | null;
    setId?: string | null;
    setName?: string | null;
    language?: Partial<ProviderScopeMappingLanguageCoordinates> | null;
  }>;
  confidence: ProviderScopeMappingConfidenceTier;
  reviewStatus?: ProviderScopeMappingReviewStatus;
  provenance: Readonly<{
    source: string;
    sourceId?: string | null;
    sourceProfileKey?: string | null;
    sourceProfileVersion?: string | null;
    mappingFingerprint?: string | null;
  }>;
  evidence?: JsonObject;
}>;

const CONFIDENCE_TIERS: readonly ProviderScopeMappingConfidenceTier[] = [
  "exact",
  "high",
  "candidate",
  "generated",
  "manual",
];

const REVIEW_STATUSES: readonly ProviderScopeMappingReviewStatus[] = [
  "proposed",
  "accepted",
  "auto-accepted",
  "rejected",
  "revoked",
];

export const PROVIDER_SCOPE_MAPPING_ACCEPTED_REVIEW_STATUSES: readonly ProviderScopeMappingReviewStatus[] = [
  "accepted",
  "auto-accepted",
];

export function isProviderScopeMappingAccepted(status: ProviderScopeMappingReviewStatus): boolean {
  return PROVIDER_SCOPE_MAPPING_ACCEPTED_REVIEW_STATUSES.includes(status);
}

export function buildProviderScopeMappingCandidate(
  input: BuildProviderScopeMappingCandidateInput,
): ProviderScopeMappingCandidate {
  const identity: ProviderScopeMappingIdentity = {
    scopeRecordId: normalizeId(input.scopeRecordId, "Provider Scope Mapping requires a scope record id."),
    providerKey: normalizeKey(input.providerKey, "Provider Scope Mapping requires a provider key."),
    unitKey: normalizeKey(input.unitKey, "Provider Scope Mapping requires a unit key."),
  };
  assert(
    CONFIDENCE_TIERS.includes(input.confidence),
    `Unknown Provider Scope Mapping confidence '${input.confidence}'.`,
  );

  const reviewStatus = input.reviewStatus ?? "proposed";
  assert(REVIEW_STATUSES.includes(reviewStatus), `Unknown Provider Scope Mapping review status '${reviewStatus}'.`);

  const coordinates = normalizeCoordinates(input.coordinates);
  assert(hasProviderCoordinate(coordinates), "Provider Scope Mapping requires at least one provider coordinate.");

  const source = input.provenance.source.trim();
  assert(source.length > 0, "Provider Scope Mapping requires provenance source.");

  return {
    ...identity,
    mappingId: computeProviderScopeMappingId(identity),
    coordinates,
    confidence: input.confidence,
    reviewStatus,
    provenance: {
      source,
      sourceId: normalizeOptional(input.provenance.sourceId),
      sourceProfileKey: normalizeOptional(input.provenance.sourceProfileKey, normalizeKeyOrNull),
      sourceProfileVersion: normalizeOptional(input.provenance.sourceProfileVersion),
      mappingFingerprint: normalizeOptional(input.provenance.mappingFingerprint),
    },
    evidence: input.evidence ?? {},
  };
}

export function computeProviderScopeMappingId(identity: ProviderScopeMappingIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeIdentity(identity)))
    .digest("hex");
}

export function normalizeProviderScopeMappingIdentity(
  input: ProviderScopeMappingIdentity,
): ProviderScopeMappingIdentity {
  return normalizeIdentity(input);
}

function normalizeIdentity(input: ProviderScopeMappingIdentity): ProviderScopeMappingIdentity {
  return {
    scopeRecordId: normalizeId(input.scopeRecordId, "Provider Scope Mapping requires a scope record id."),
    providerKey: normalizeKey(input.providerKey, "Provider Scope Mapping requires a provider key."),
    unitKey: normalizeKey(input.unitKey, "Provider Scope Mapping requires a unit key."),
  };
}

function normalizeCoordinates(
  coordinates: BuildProviderScopeMappingCandidateInput["coordinates"],
): ProviderScopeMappingCoordinates {
  return {
    productLineId: normalizeOptional(coordinates.productLineId),
    seriesId: normalizeOptional(coordinates.seriesId),
    setId: normalizeOptional(coordinates.setId),
    setName: normalizeOptional(coordinates.setName),
    language: {
      languageCode: normalizeOptional(coordinates.language?.languageCode, normalizeKeyOrNull),
      providerLanguageCode: normalizeOptional(coordinates.language?.providerLanguageCode, normalizeKeyOrNull),
      providerLanguageId: normalizeOptional(coordinates.language?.providerLanguageId),
      providerLocale: normalizeOptional(coordinates.language?.providerLocale, normalizeKeyOrNull),
      providerLanguageName: normalizeOptional(coordinates.language?.providerLanguageName),
    },
  };
}

function hasProviderCoordinate(coordinates: ProviderScopeMappingCoordinates): boolean {
  return Boolean(
    coordinates.productLineId ??
    coordinates.seriesId ??
    coordinates.setId ??
    coordinates.setName ??
    coordinates.language.languageCode ??
    coordinates.language.providerLanguageCode ??
    coordinates.language.providerLanguageId ??
    coordinates.language.providerLocale ??
    coordinates.language.providerLanguageName,
  );
}

function normalizeId(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeKey(value: string, message: string): string {
  const normalized = normalizeKeyOrNull(value);
  assert(normalized !== null, message);
  return normalized;
}

function normalizeKeyOrNull(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptional(
  value: string | null | undefined,
  normalizer: (value: string | null | undefined) => string | null = (candidate) => {
    const normalized = candidate?.trim() ?? "";
    return normalized.length > 0 ? normalized : null;
  },
): string | null {
  return normalizer(value);
}
