const planBlocks = [
  "ambiguous-conflict-resolution",
  "ambiguous-duplicate-candidates",
  "ambiguous-target",
  "asset-provenance-ambiguous",
  "candidate-has-blocking-conflicts",
  "candidate-not-ready",
  "conflicting-external-reference-level",
  "display-identity-unresolvable",
  "duplicate-external-catalog-item-reference",
  "duplicate-external-product-reference",
  "external-product-reference-duplicate-dimension",
  "external-product-reference-missing-selected-options",
  "inactive-target",
  "incompatible-target",
  "member-revision-missing",
  "missing-catalog-item-target",
  "missing-create-catalog-item-id",
  "missing-field-value",
  "missing-reference-record-target",
  "missing-title",
  "no-promotable-member",
  "profile-disagreement",
  "promotion-facts-missing",
  "promotion-profile-ambiguous",
  "promotion-profile-inactive",
  "promotion-profile-incompatible",
  "promotion-profile-unavailable",
  "reference-provenance-ambiguous",
  "unsupported-promotion-intent",
] as const;

const applicationRefusals = [
  "bound-elsewhere",
  "conflicting-history",
  "invalid-plan-fingerprint",
  "member-history-conflict",
  "missing-reference-evidence",
  "partial-target",
  "profile-missing",
  "profile-revoked",
  "target-history-conflict",
  "unplanned-target-history",
] as const;

export type CatalogMergeCandidatePromotionPlanBlock = (typeof planBlocks)[number];
export type CatalogMergeCandidatePromotionApplicationRefusal = (typeof applicationRefusals)[number];

type PlanBlockCode = `promotion-plan-blocked:${CatalogMergeCandidatePromotionPlanBlock}`;
type ApplicationRefusalCode = `promotion-application-${CatalogMergeCandidatePromotionApplicationRefusal}`;

const otherDiagnostics = [
  "asset-processing-failed",
  "promotion-reference-target-unresolved",
  "unexpected-promotion-error",
] as const;

export type CatalogMergeCandidateApplicationDiagnosticCode =
  | PlanBlockCode
  | ApplicationRefusalCode
  | (typeof otherDiagnostics)[number];

export type CatalogMergeCandidateFailureDiagnosticCode = Exclude<
  CatalogMergeCandidateApplicationDiagnosticCode,
  "asset-processing-failed"
>;

const diagnosticCodes = new Set<unknown>([
  ...planBlocks.map((code) => `promotion-plan-blocked:${code}`),
  ...applicationRefusals.map((code) => `promotion-application-${code}`),
  ...otherDiagnostics,
]);

export function isCatalogMergeCandidateApplicationDiagnosticCode(
  value: unknown,
): value is CatalogMergeCandidateApplicationDiagnosticCode {
  return diagnosticCodes.has(value);
}

export function isCatalogMergeCandidateFailureDiagnosticCode(
  value: unknown,
): value is CatalogMergeCandidateFailureDiagnosticCode {
  return value !== "asset-processing-failed" && isCatalogMergeCandidateApplicationDiagnosticCode(value);
}
