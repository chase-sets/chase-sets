# Admin Control Plane Query Contracts

The Catalog Admin Control Plane reads provider integration state through typed query contracts owned by Source Observations. UI workflow modules should call these contracts by query key and render the returned read models; they should not parse provider profile JSON, branch by provider/product category, or infer transport health from Catalog semantic readiness.

The authoritative TypeScript contract surface lives in:

```text
bounded-contexts/catalog/features/source-observations/api/admin-control-plane-read-model-contracts.ts
```

Performance, pagination, indexing, and stale-state expectations for this query inventory are documented in [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md). The authoritative typed SLO surface lives in:

```text
bounded-contexts/catalog/features/source-observations/api/admin-control-plane-read-model-slos.ts
```

## Boundary Rules

- Catalog semantic readiness is grouped by ingestion unit and must include `unitKey`.
- Provider transport readiness is grouped by provider/adapter. Transport diagnostics may include `unitKey` when the adapter can attribute the finding to one ingestion unit, but provider-wide diagnostics remain adapter-scoped.
- Jobs, Source Observations, audit records, diagnostics, profile read models, promotion plans, replay/reapply impact, fixture validation, dry-run evidence, rollback, and retirement impact must include `unitKey`.
- Product domain and product form are data on generic ingestion-unit read models. They are not admin page branches.
- Planned projections in this contract are explicit follow-on implementation points, not permission for UI modules to inspect raw JSON snapshots.

## Query Inventory

| Query key | Read model | Grouping | Unit key | Freshness |
| --- | --- | --- | --- | --- |
| `integration-health-summary` | `CatalogAdminIntegrationHealthSummaryReadModel` | ingestion unit | required | request-time |
| `provider-transport-readiness-summary` | `CatalogAdminProviderTransportReadinessSummaryReadModel` | provider adapter | optional | request-time |
| `active-profile-version-summary` | `CatalogAdminActiveProfileVersionSummaryReadModel` | ingestion unit | required | transactional projection |
| `profile-section-status-summary` | `CatalogAdminProfileSectionStatusSummaryReadModel` | ingestion unit | required | transactional projection |
| `adapter-transport-diagnostics` | `CatalogAdminAdapterTransportDiagnosticsReadModel` | provider adapter | optional | request-time |
| `fixture-validation-summary` | `CatalogAdminFixtureValidationSummaryReadModel` | ingestion unit | required | transactional projection |
| `dry-run-evidence-summary` | `CatalogAdminDryRunEvidenceSummaryReadModel` | ingestion unit | required | request-time |
| `semantic-version-comparison` | `CatalogAdminSemanticVersionComparisonReadModel` | ingestion unit | required | request-time |
| `activation-readiness-summary` | `CatalogAdminActivationReadinessSummaryReadModel` | ingestion unit | required | request-time |
| `replay-reapply-impact-summary` | `CatalogAdminReplayReapplyImpactSummaryReadModel` | ingestion unit | required | request-time |
| `import-job-progress-summary` | `CatalogAdminImportJobProgressSummaryReadModel` | job | required | durable job checkpoint |
| `source-observation-review-query` | `CatalogAdminSourceObservationReviewReadModel` | observation | required | transactional projection |
| `promotion-plan-preview` | `CatalogAdminPromotionPlanPreviewReadModel` | ingestion unit | required | request-time |
| `rollback-retirement-impact-summary` | `CatalogAdminRollbackRetirementImpactSummaryReadModel` | ingestion unit | required | request-time |
| `audit-evidence-timeline` | `CatalogAdminAuditEvidenceTimelineReadModel` | timeline | required | eventual projection |

## Source Inventory

Existing Catalog sources:

- `catalog_source_observations`
- `catalog_provider_integration_profile_versions`
- `catalog_provider_profile_version_sections`
- `catalog_provider_profile_version_section_diagnostics`
- `ProviderAdapterRegistry.listIntegrationUnits`
- `ProviderAdapterRegistry.getTransportDiagnostics`
- `CatalogIntegrationEngine.getCatalogIntegrationControlPlaneReadiness`
- `evaluateCatalogProviderProfileActivationReadiness`
- `planCatalogProviderPromotionCommands`

Existing Platform durable job sources interpreted by Catalog read models:

- `catalog_source_observation_integration_durable_jobs`
- `catalog_source_observation_integration_work_units`
- `catalog_source_observation_bulk_review_jobs`
- `catalog_source_observation_bulk_review_work_units`

Job consistency and lifecycle blocking policy is defined in [Catalog Integration Job Consistency](./catalog-integration-job-consistency.md).

Planned Catalog projections defined for follow-on implementation:

- `catalog_admin_dry_run_evidence_projection`
- `catalog_admin_profile_semantic_diff_projection`
- `catalog_admin_replay_reapply_impact_projection`
- `catalog_admin_profile_lifecycle_impact_projection`
- `catalog_admin_audit_evidence_timeline_projection`

## Freshness Expectations

- `request-time`: assembled from runtime services during the request. Use for adapter diagnostics, dry runs, semantic compare, activation readiness, promotion preview, and impact preview where the operator expects current evaluation.
- `transactional-projection`: backed by existing Catalog projection tables updated with the source mutation transaction. Use for profile section status and Source Observation review queries.
- `durable-job-checkpoint`: backed by durable job rows and work-unit checkpoints. Use for active and completed job progress.
- `eventual-projection`: projected from events and operational evidence after the source transaction. Use for timeline views that can show projection lag.

## Section-Scoped Semantics

Profile authoring read models must carry section keys and domain concepts so Admin views can group diagnostics without parsing paths:

- `profile-section-status-summary` exposes per-section `sectionStatus` values: valid, warning, error, or blocked.
- `semantic-version-comparison` emits each change with `sectionKey` and `domainConcept`, plus section groups for compare panels.
- `activation-readiness-summary` emits checks with diagnostic code, section key, domain concept, remediation, and blocking behavior, plus domain groups for activation dialogs.
- `dry-run-evidence-summary` links diagnostics back to section keys and fixture flows so fixture failures can focus the relevant authoring controls.

## Job Consistency Fields

`import-job-progress-summary` must expose durable state and operator status separately:

- `state`: durable job state from the platform job row.
- `operatorStatus`: queued, running, stale, retried, partial, failed, or completed.
- `profile`: provider/profile snapshot including connector kind, connector source version, and source mapping fingerprint.
- `reapplyProfileMode`: original-source-profile, current-active-profile, or null.
- `consistency`: policy names for duplicate submission reuse, profile snapshot timing, retry/resume behavior, partial failures, and claim mode.
- `failed`, `skipped`, and `workUnits`: mixed-outcome and work-unit checkpoint summary fields used to explain partial jobs.

## Error States

Contracts declare operator-facing error states instead of leaking storage exceptions. Common states include:

- `adapter_unavailable`
- `source_projection_stale`
- `profile_version_missing`
- `profile_section_projection_missing`
- `fixture_validation_blocked`
- `dry_run_blocked`
- `semantic_diff_unavailable`
- `activation_blocked`
- `impact_projection_unavailable`
- `job_not_found`
- `observation_not_found`
- `promotion_plan_unavailable`
- `audit_projection_unavailable`
- `permission_denied`

UI modules should render these states as blocked, degraded, or empty workflows. They should not recover by querying lower-level tables or profile JSON directly.

The SLO contract narrows degraded rendering into `fresh`, `stale`, `lagging`, `partial`, and `unavailable` UI states. Views backed by durable job checkpoints or eventual projections must show lag reason and last generated timestamp when the model is stale or lagging.

## Adding Providers Or Product Categories

Adding a new provider, product domain, or product form should add provider adapters, profile sections, fixtures, and semantic primitives. It should not add new Admin query keys, route branches, or provider-specific page modules. The ingestion unit identity carries `providerKey`, `productDomain`, `productForm`, and optional `ingestionPurpose`; all Admin read models consume those fields generically.
