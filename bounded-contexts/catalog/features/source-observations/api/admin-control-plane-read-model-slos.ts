import {
  catalogAdminControlPlaneQueryKeys,
  type CatalogAdminControlPlaneFreshnessExpectation,
  type CatalogAdminControlPlaneQueryKey,
} from "./admin-control-plane-read-model-contracts";

export type CatalogAdminControlPlaneFreshnessState = "fresh" | "stale" | "lagging" | "partial" | "unavailable";

export type CatalogAdminControlPlanePaginationMode = "none" | "offset" | "cursor" | "sse";

export type CatalogAdminControlPlanePerformanceCheckKind = "unit-test" | "smoke" | "explain-plan" | "load-sample";

export type CatalogAdminControlPlaneReadModelSlo = Readonly<{
  key: CatalogAdminControlPlaneQueryKey;
  latency: CatalogAdminControlPlaneLatencySlo;
  freshness: CatalogAdminControlPlaneFreshnessSlo;
  pagination: CatalogAdminControlPlanePaginationSlo;
  queryShape: CatalogAdminControlPlaneQueryShapeSlo;
  highVolume: boolean;
  performanceChecks: readonly CatalogAdminControlPlanePerformanceCheck[];
}>;

export type CatalogAdminControlPlaneLatencySlo = Readonly<{
  p95Ms: number;
  timeoutMs: number;
  notes: string;
}>;

export type CatalogAdminControlPlaneFreshnessSlo = Readonly<{
  expectation: CatalogAdminControlPlaneFreshnessExpectation;
  freshWithinSeconds: number;
  staleAfterSeconds: number;
  unavailableAfterSeconds: number;
  states: readonly CatalogAdminControlPlaneFreshnessState[];
  staleStateMessage: string;
}>;

export type CatalogAdminControlPlanePaginationSlo = Readonly<{
  mode: CatalogAdminControlPlanePaginationMode;
  required: boolean;
  defaultLimit: number | null;
  maxLimit: number | null;
  cursorFields: readonly string[];
  notes: string;
}>;

export type CatalogAdminControlPlaneQueryShapeSlo = Readonly<{
  primaryFilters: readonly string[];
  orderBy: readonly string[];
  existingIndexes: readonly string[];
  plannedIndexes: readonly string[];
  notes: string;
}>;

export type CatalogAdminControlPlanePerformanceCheck = Readonly<{
  kind: CatalogAdminControlPlanePerformanceCheckKind;
  representativeRows: number;
  expectation: string;
}>;

export const catalogAdminControlPlaneFreshnessStates = [
  "fresh",
  "stale",
  "lagging",
  "partial",
  "unavailable",
] as const satisfies readonly CatalogAdminControlPlaneFreshnessState[];

export const catalogAdminControlPlaneReadModelSlos = [
  slo({
    key: "integration-health-summary",
    latency: latency(300, 1_500, "Dashboard summary should render without blocking operator triage."),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("none", false, null, null, []),
    queryShape: queryShape(
      ["providerKey", "unitKey"],
      ["providerKey", "unitKey"],
      [
        "catalog_provider_integration_profile_versions_active_idx",
        "catalog_provider_profile_version_sections_ingestion_unit_idx",
      ],
      [],
      "Bounded by registered provider adapters and active profile versions.",
    ),
    highVolume: false,
    performanceChecks: [check("unit-test", 10, "Every registered adapter contributes bounded readiness rows.")],
  }),
  slo({
    key: "provider-transport-readiness-summary",
    latency: latency(250, 1_500, "Adapter readiness is request-time and should stay a lightweight provider call."),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("none", false, null, null, []),
    queryShape: queryShape(["providerKey", "adapterKey"], ["providerKey"], [], [], "Provider adapter runtime data."),
    highVolume: false,
    performanceChecks: [check("smoke", 10, "Adapter diagnostics request completes within the dashboard budget.")],
  }),
  slo({
    key: "provider-source-options",
    latency: latency(
      400,
      2_000,
      "Provider source options should populate dependent selectors without stalling review.",
    ),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 25, 100, ["queryKind", "cursor"]),
    queryShape: queryShape(
      ["providerKey", "profileVersion", "queryKind", "languageCode", "parentValue"],
      ["label", "value"],
      ["catalog_provider_option_query_cache_lookup_idx", "catalog_provider_option_query_cache_stale_until_idx"],
      [],
      "Provider option pages use the cache lookup key first, then refresh through bounded provider queries.",
    ),
    highVolume: false,
    performanceChecks: [
      check("unit-test", 1_000, "Provider option pages preserve cache metadata and parent selection."),
    ],
  }),
  slo({
    key: "active-profile-version-summary",
    latency: latency(250, 1_500, "Profile workspace header reads should be instant-feeling."),
    freshness: freshness("transactional-projection", 5, 30, 180, ["fresh", "stale", "unavailable"]),
    pagination: pagination("none", false, null, null, []),
    queryShape: queryShape(
      ["providerKey", "active", "lifecycle", "ingestionUnitKey"],
      ["providerKey", "profileVersion DESC"],
      [
        "catalog_provider_integration_profile_versions_active_idx",
        "catalog_provider_integration_profile_versions_provider_idx",
        "catalog_provider_profile_version_sections_ingestion_unit_idx",
      ],
      [],
      "Provider-active and ingestion-unit profile pointers are small bounded lookups.",
    ),
    highVolume: false,
    performanceChecks: [check("unit-test", 100, "Active profile lookup stays index-backed.")],
  }),
  slo({
    key: "profile-section-status-summary",
    latency: latency(300, 2_000, "Profile section diagnostics power the authoring workspace."),
    freshness: freshness("transactional-projection", 5, 30, 180, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("none", false, null, null, []),
    queryShape: queryShape(
      ["providerKey", "profileKey", "profileVersion", "ingestionUnitKey", "validationStatus"],
      ["sectionKey"],
      [
        "catalog_provider_profile_version_sections_provider_idx",
        "catalog_provider_profile_version_sections_ingestion_unit_idx",
        "catalog_provider_profile_version_section_diagnostics_lookup_idx",
      ],
      [],
      "Section rows are bounded by the section registry; diagnostics are joined by section key.",
    ),
    highVolume: false,
    performanceChecks: [check("unit-test", 1_000, "Section status lookup remains bounded by profile version.")],
  }),
  slo({
    key: "adapter-transport-diagnostics",
    latency: latency(300, 2_000, "Adapter diagnostics may include provider checks but must not stall the UI shell."),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("offset", true, 50, 200, []),
    queryShape: queryShape(
      ["providerKey", "adapterKey", "severity", "unitKey"],
      ["severity", "providerKey"],
      [],
      ["catalog_admin_adapter_diagnostics_provider_severity_idx"],
      "Runtime diagnostics are bounded today; persisted diagnostics must page by provider/severity/time.",
    ),
    highVolume: true,
    performanceChecks: [check("smoke", 500, "Diagnostics list renders first page within latency budget.")],
  }),
  slo({
    key: "fixture-validation-summary",
    latency: latency(400, 2_000, "Fixture validation summaries may aggregate diagnostics but stay profile-scoped."),
    freshness: freshness("transactional-projection", 5, 30, 180, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("offset", true, 50, 200, []),
    queryShape: queryShape(
      ["unitKey", "providerKey", "profileVersion", "flow", "severity"],
      ["flow", "severity", "path"],
      [
        "catalog_provider_profile_version_sections_ingestion_unit_idx",
        "catalog_provider_profile_version_section_diagnostics_lookup_idx",
      ],
      ["catalog_admin_fixture_validation_unit_flow_idx"],
      "Large fixture suites should page diagnostic rows while keeping coverage summaries bounded.",
    ),
    highVolume: true,
    performanceChecks: [check("load-sample", 2_500, "Fixture diagnostic first page remains under p95 budget.")],
  }),
  slo({
    key: "dry-run-evidence-summary",
    latency: latency(
      750,
      5_000,
      "Dry-run summaries can evaluate mapping contracts but must return safe evidence quickly.",
    ),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("offset", true, 25, 100, []),
    queryShape: queryShape(
      ["unitKey", "providerKey", "profileVersion", "flow", "severity"],
      ["path"],
      [],
      ["catalog_admin_dry_run_evidence_unit_profile_flow_idx"],
      "Dry-run evidence must page redacted evidence rows and never expose raw payload blobs by default.",
    ),
    highVolume: true,
    performanceChecks: [check("smoke", 250, "Dry-run evidence response includes bounded redacted evidence.")],
  }),
  slo({
    key: "semantic-version-comparison",
    latency: latency(500, 3_000, "Semantic compare should be usable inside activation review."),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("offset", true, 50, 200, []),
    queryShape: queryShape(
      ["unitKey", "providerKey", "candidateProfileVersion", "activeProfileVersion", "severity"],
      ["severity", "path"],
      ["catalog_provider_integration_profile_versions_provider_idx"],
      ["catalog_admin_profile_semantic_diff_unit_profile_idx"],
      "Diff output may be generated request-time first; persisted diffs need unit/profile indexes.",
    ),
    highVolume: true,
    performanceChecks: [check("unit-test", 1_000, "Semantic diff can page high-change profile comparisons.")],
  }),
  slo({
    key: "activation-readiness-summary",
    latency: latency(350, 2_000, "Activation checks must be responsive enough for guided workflows."),
    freshness: freshness("request-time", 15, 60, 300, ["fresh", "partial", "unavailable"]),
    pagination: pagination("none", false, null, null, []),
    queryShape: queryShape(
      ["unitKey", "providerKey", "profileVersion"],
      ["checkKey"],
      [
        "catalog_provider_integration_profile_versions_provider_idx",
        "catalog_provider_profile_version_sections_ingestion_unit_idx",
      ],
      [],
      "Activation checks are bounded by the readiness rule set.",
    ),
    highVolume: false,
    performanceChecks: [check("unit-test", 100, "Activation checks stay bounded by profile readiness inputs.")],
  }),
  slo({
    key: "replay-reapply-impact-summary",
    latency: latency(
      750,
      5_000,
      "Impact preview may count large Source Observation scopes but must not block imports.",
    ),
    freshness: freshness("request-time", 15, 90, 300, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 100, 500, ["observedAt", "observationId"]),
    queryShape: queryShape(
      ["unitKey", "providerKey", "sourceProfileVersion", "status", "observedAt"],
      ["observedAt DESC", "observationId DESC"],
      [
        "catalog_source_observations_provider_idx",
        "catalog_source_observations_status_idx",
        "catalog_source_observations_source_profile_idx",
      ],
      ["catalog_source_observations_admin_replay_impact_idx"],
      "High-volume impact previews should use keyset pagination after the first count summary.",
    ),
    highVolume: true,
    performanceChecks: [check("explain-plan", 50_000, "Replay impact query uses provider/profile/status/time index.")],
  }),
  slo({
    key: "import-job-progress-summary",
    latency: latency(300, 2_000, "Active job progress is an operator control surface."),
    freshness: freshness("durable-job-checkpoint", 5, 30, 180, ["fresh", "stale", "lagging", "unavailable"]),
    pagination: pagination("sse", true, 50, 200, ["jobId", "sequence"]),
    queryShape: queryShape(
      ["jobKind", "status", "updatedAt", "jobId", "state"],
      ["updatedAt DESC", "sequence ASC"],
      [
        "catalog_source_observation_integration_durable_jobs_status_created_idx",
        "catalog_source_observation_integration_durable_jobs_kind_status_idx",
        "catalog_source_observation_integration_job_events_lookup_idx",
        "catalog_source_observation_integration_work_units_job_state_idx",
        "catalog_source_observation_bulk_review_jobs_status_created_idx",
        "catalog_source_observation_bulk_review_work_units_job_state_idx",
      ],
      [],
      "Job lists use durable job indexes; per-job event streams use Last-Event-ID sequence cursors.",
    ),
    highVolume: true,
    performanceChecks: [
      check("smoke", 10_000, "Active job list and SSE replay remain bounded by job id and sequence."),
    ],
  }),
  slo({
    key: "source-observation-review-query",
    latency: latency(500, 3_000, "Review lists are high-frequency operator workflows."),
    freshness: freshness("transactional-projection", 5, 30, 180, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 100, 500, ["observedAt", "observationId"]),
    queryShape: queryShape(
      ["unitKey", "providerKey", "sourceProfileVersion", "status", "languageCode", "setId", "observedAt"],
      ["observedAt DESC", "observationId DESC"],
      [
        "catalog_source_observations_provider_idx",
        "catalog_source_observations_status_idx",
        "catalog_source_observations_source_profile_idx",
        "catalog_source_observations_name_idx",
      ],
      ["catalog_source_observations_admin_review_idx", "catalog_source_observations_admin_scope_time_idx"],
      "Offset remains acceptable for small existing pages; high-volume admin review must move to keyset pagination.",
    ),
    highVolume: true,
    performanceChecks: [check("explain-plan", 100_000, "Review query uses provider/profile/status/time index.")],
  }),
  slo({
    key: "promotion-plan-preview",
    latency: latency(750, 5_000, "Promotion preview can evaluate mapping evidence but must remain interactive."),
    freshness: freshness("request-time", 15, 90, 300, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 100, 500, ["observedAt", "observationId"]),
    queryShape: queryShape(
      ["unitKey", "providerKey", "promotionProfileVersion", "status", "scope"],
      ["observedAt DESC", "observationId DESC"],
      [
        "catalog_source_observations_provider_idx",
        "catalog_source_observations_status_idx",
        "catalog_source_observations_promotion_profile_idx",
      ],
      ["catalog_source_observations_admin_promotion_scope_idx"],
      "Promotion previews should summarize counts first, then page commands/evidence.",
    ),
    highVolume: true,
    performanceChecks: [check("explain-plan", 50_000, "Promotion preview scope query stays index-backed.")],
  }),
  slo({
    key: "rollback-retirement-impact-summary",
    latency: latency(750, 5_000, "Lifecycle impact is a destructive-action guardrail."),
    freshness: freshness("request-time", 15, 90, 300, ["fresh", "stale", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 100, 500, ["updatedAt", "observationId"]),
    queryShape: queryShape(
      ["unitKey", "providerKey", "sourceProfileVersion", "promotionProfileVersion", "status"],
      ["updatedAt DESC", "observationId DESC"],
      [
        "catalog_source_observations_source_profile_idx",
        "catalog_source_observations_promotion_profile_idx",
        "catalog_provider_integration_profile_versions_provider_idx",
      ],
      ["catalog_source_observations_admin_profile_reference_idx"],
      "Rollback and retirement impact must show a bounded first page plus counts before destructive actions.",
    ),
    highVolume: true,
    performanceChecks: [check("explain-plan", 100_000, "Profile reference impact query uses profile/version indexes.")],
  }),
  slo({
    key: "audit-evidence-timeline",
    latency: latency(500, 3_000, "Audit timelines must support operator incident review without long scans."),
    freshness: freshness("eventual-projection", 30, 120, 600, ["fresh", "stale", "lagging", "partial", "unavailable"]),
    pagination: pagination("cursor", true, 50, 200, ["occurredAt", "eventId"]),
    queryShape: queryShape(
      ["unitKey", "providerKey", "profileVersion", "eventName", "occurredAt"],
      ["occurredAt DESC", "eventId DESC"],
      ["event_store_events_context_category_type_global_idx", "event_store_events_context_category_global_idx"],
      ["catalog_admin_audit_evidence_timeline_unit_time_idx"],
      "Projected timeline queries page by unit/time; rebuilds use event projection context/category indexes.",
    ),
    highVolume: true,
    performanceChecks: [
      check("explain-plan", 100_000, "Timeline projection and rebuild reads avoid broad event scans."),
    ],
  }),
] as const satisfies readonly CatalogAdminControlPlaneReadModelSlo[];

export const catalogAdminControlPlaneReadModelSlosByKey: Readonly<
  Record<CatalogAdminControlPlaneQueryKey, CatalogAdminControlPlaneReadModelSlo>
> = Object.fromEntries(catalogAdminControlPlaneReadModelSlos.map((entry) => [entry.key, entry])) as Readonly<
  Record<CatalogAdminControlPlaneQueryKey, CatalogAdminControlPlaneReadModelSlo>
>;

export function getCatalogAdminControlPlaneReadModelSlo(
  key: CatalogAdminControlPlaneQueryKey,
): CatalogAdminControlPlaneReadModelSlo {
  return catalogAdminControlPlaneReadModelSlosByKey[key];
}

function slo(input: CatalogAdminControlPlaneReadModelSlo): CatalogAdminControlPlaneReadModelSlo {
  return input;
}

function latency(p95Ms: number, timeoutMs: number, notes: string): CatalogAdminControlPlaneLatencySlo {
  return { p95Ms, timeoutMs, notes };
}

function freshness(
  expectation: CatalogAdminControlPlaneFreshnessExpectation,
  freshWithinSeconds: number,
  staleAfterSeconds: number,
  unavailableAfterSeconds: number,
  states: readonly CatalogAdminControlPlaneFreshnessState[],
): CatalogAdminControlPlaneFreshnessSlo {
  return {
    expectation,
    freshWithinSeconds,
    staleAfterSeconds,
    unavailableAfterSeconds,
    states,
    staleStateMessage: "Show the last generated timestamp, lag reason, and a retry or refresh affordance.",
  };
}

function pagination(
  mode: CatalogAdminControlPlanePaginationMode,
  required: boolean,
  defaultLimit: number | null,
  maxLimit: number | null,
  cursorFields: readonly string[],
): CatalogAdminControlPlanePaginationSlo {
  return {
    mode,
    required,
    defaultLimit,
    maxLimit,
    cursorFields,
    notes:
      mode === "none"
        ? "The read model is bounded by profile, adapter, or section inventory."
        : "High-volume views must preserve filters server-side and expose stable next-page state.",
  };
}

function queryShape(
  primaryFilters: readonly string[],
  orderBy: readonly string[],
  existingIndexes: readonly string[],
  plannedIndexes: readonly string[],
  notes: string,
): CatalogAdminControlPlaneQueryShapeSlo {
  return { primaryFilters, orderBy, existingIndexes, plannedIndexes, notes };
}

function check(
  kind: CatalogAdminControlPlanePerformanceCheckKind,
  representativeRows: number,
  expectation: string,
): CatalogAdminControlPlanePerformanceCheck {
  return { kind, representativeRows, expectation };
}

export function assertCatalogAdminControlPlaneSloCoverage(): void {
  const missingKeys = catalogAdminControlPlaneQueryKeys.filter(
    (key) => !catalogAdminControlPlaneReadModelSlosByKey[key],
  );
  if (missingKeys.length > 0) {
    throw new Error(`Missing Admin Control Plane read-model SLOs for: ${missingKeys.join(", ")}`);
  }
}
