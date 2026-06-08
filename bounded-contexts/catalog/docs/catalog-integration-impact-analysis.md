# Catalog Integration Impact Analysis

Catalog owns impact analysis for integration-control-plane actions that can change how provider facts affect Catalog truth. The model is request-time and reads committed Catalog Source Observation, provider profile, and durable job state. It never calls live provider APIs and never exposes raw provider payloads.

## Covered Actions

- Reapply/replay preview for promoted Source Observations.
- Activation preview for a candidate provider profile version.
- Rollback preview for reactivating a prior provider profile version.
- Deprecation preview for an active or inactive provider profile version.
- Retirement preview for a provider profile version.

## Data Sources

Impact analysis reads:

- `catalog_source_observations`
- `catalog_provider_integration_profile_versions`
- `catalog_source_observation_integration_durable_jobs`
- `catalog_source_observation_bulk_review_jobs`
- durable job work-unit summaries when job progress is needed

The model groups by ingestion unit and profile pointer. Source Observation scopes are bounded by provider, language, set or expansion, status, and search filters. Profile lifecycle scopes are bounded by provider key and profile version.

## Reapply And Replay Impact

Reapply impact counts:

- matched observations in the requested filter scope
- eligible observations with `promoted` status
- blocked observations outside the promoted reapply set
- distinct impacted Catalog Item IDs, with a bounded sample
- external catalog-item and product references, with bounded provider/key samples
- sample Source Observation IDs
- active same-provider import, reapply, or promote jobs that may overlap the preview

The existing `/api/catalog/source-observations/reapply/preview` response includes the same impact summary used by the Admin read model so the confirm dialog does not estimate workload from UI-only counts.

The typed Admin read model is `CatalogAdminReplayReapplyImpactSummaryReadModel`, exposed by `/api/catalog/source-observations/reapply/impact` when the caller supplies provider key, profile version, and a Source Observation scope.

## Lifecycle Impact

Lifecycle impact counts:

- Source Observations that reference the profile version as their source profile
- Source Observations that reference the profile version as their promotion profile
- distinct impacted Catalog Item IDs, with a bounded sample
- external catalog-item and product references, with bounded provider/key samples
- sample Source Observation IDs
- active same-provider import, reapply, or promote jobs

Rollback and deprecation are blocked while same-provider import, reapply, or promote jobs are queued or running. Retirement is also blocked while any Source Observation still references the profile version as either source or promotion evidence. Reject jobs are excluded because they do not execute provider mapping or refresh promoted Catalog Items.

The typed Admin read model is `CatalogAdminRollbackRetirementImpactSummaryReadModel`, exposed by `/api/catalog/source-observations/provider-profiles/:providerKey/:profileVersion/lifecycle-impact?operation=activation|rollback|deprecate|retire`.

## Samples And Large Scopes

Impact APIs return complete counts and bounded samples. Samples default to small keyset-style slices and are capped so high-volume providers do not force the Admin UI to page through every affected Source Observation or Catalog Item before confirmation.

Large-scope operator flows must use counts, diagnostics, and sample IDs for preview. The confirm endpoint must re-resolve the server-side scope before enqueueing or executing work.

## Governance

Impact evidence may include:

- Source Observation IDs
- Catalog Item IDs
- provider key
- external reference key
- profile key and profile version
- counts, statuses, and diagnostic codes

Impact evidence must not include raw provider payloads, provider credentials, cookies, seller/account facts, listing facts, prices, inventory, quantities, order facts, or provider-controlled commerce values that Catalog does not own.

## Diagnostics

Impact diagnostics use Catalog-owned codes and operator severity:

- `reapply-scope-ineligible-observations`
- `reapply-scope-active-jobs`
- `profile-lifecycle-active-jobs`
- `profile-retirement-referenced-observations`

Warnings are advisory for reapply preview. Lifecycle diagnostics are blockers when they would race queued/running work or violate retirement reference rules.
