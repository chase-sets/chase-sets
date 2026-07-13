// Client-facing shapes for the unmapped-scope inbox and scope coverage matrix.
// Type-only re-export: the admin-contracts module already produces exactly
// the JSON shape the HTTP route returns, so the UI reuses it verbatim instead
// of duplicating the same fields under a second name.
export type {
  ProviderScopeMappingCandidateSummary,
  ScopeCoverageMatrix,
  ScopeCoverageProviderRow,
  ScopeCoverageState,
  UnmappedScopeInboxGroup,
  UnmappedScopeInboxReadModel,
} from "../api/scope-coverage-admin-contracts";
export type {
  ProviderScopeMappingConfidenceTier,
  ProviderScopeMappingCoordinates,
  ProviderScopeMappingReviewStatus,
} from "../domain/mapping";
