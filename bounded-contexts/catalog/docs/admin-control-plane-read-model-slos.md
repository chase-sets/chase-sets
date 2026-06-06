# Admin Control Plane Read-Model SLOs

The Admin Control Plane query contracts define what Catalog read models exist. This document defines the performance, pagination, indexing, freshness, and degraded-state expectations those read models must meet before Admin UI modules depend on them for high-volume operator workflows.

The authoritative typed SLO inventory lives in:

```text
bounded-contexts/catalog/features/source-observations/api/admin-control-plane-read-model-slos.ts
```

## Boundary Rules

- SLOs are keyed by the query inventory in [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md). A new Admin query key must add an SLO entry in the same slice.
- Catalog owns SLOs for Source Observation, provider profile, activation, promotion, replay/reapply, lifecycle, and audit read models.
- Platform owns generic durable job mechanics, event projection runtime, replay headers, queue leases, and deployment observability. Catalog read models may depend on those platform guarantees without moving Catalog query semantics into Platform.
- UI modules must render freshness and degraded states from the read model contract. They must not recover by reading raw provider profile JSON, durable job tables, or Source Observation rows directly.
- Planned indexes below are implementation requirements for the API/projection slices that materialize those views. Existing summary views may stay bounded and unpaginated.

## Latency And Freshness Inventory

| Query key | p95 | Timeout | Freshness | Fresh within | Stale after | Unavailable after | Pagination |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
| `integration-health-summary` | 300 ms | 1500 ms | request-time | 15s | 60s | 300s | none |
| `provider-transport-readiness-summary` | 250 ms | 1500 ms | request-time | 15s | 60s | 300s | none |
| `active-profile-version-summary` | 250 ms | 1500 ms | transactional projection | 5s | 30s | 180s | none |
| `profile-section-status-summary` | 300 ms | 2000 ms | transactional projection | 5s | 30s | 180s | none |
| `adapter-transport-diagnostics` | 300 ms | 2000 ms | request-time | 15s | 60s | 300s | offset, 50 default, 200 max |
| `fixture-validation-summary` | 400 ms | 2000 ms | transactional projection | 5s | 30s | 180s | offset, 50 default, 200 max |
| `dry-run-evidence-summary` | 750 ms | 5000 ms | request-time | 15s | 60s | 300s | offset, 25 default, 100 max |
| `semantic-version-comparison` | 500 ms | 3000 ms | request-time | 15s | 60s | 300s | offset, 50 default, 200 max |
| `activation-readiness-summary` | 350 ms | 2000 ms | request-time | 15s | 60s | 300s | none |
| `replay-reapply-impact-summary` | 750 ms | 5000 ms | request-time | 15s | 90s | 300s | cursor, 100 default, 500 max |
| `import-job-progress-summary` | 300 ms | 2000 ms | durable job checkpoint | 5s | 30s | 180s | SSE, 50 default replay, 200 max replay |
| `source-observation-review-query` | 500 ms | 3000 ms | transactional projection | 5s | 30s | 180s | cursor, 100 default, 500 max |
| `promotion-plan-preview` | 750 ms | 5000 ms | request-time | 15s | 90s | 300s | cursor, 100 default, 500 max |
| `rollback-retirement-impact-summary` | 750 ms | 5000 ms | request-time | 15s | 90s | 300s | cursor, 100 default, 500 max |
| `audit-evidence-timeline` | 500 ms | 3000 ms | eventual projection | 30s | 120s | 600s | cursor, 50 default, 200 max |

## UI Freshness States

Read models must expose enough metadata for the Admin UI to distinguish these states:

- `fresh`: the read model is inside its `freshWithinSeconds` budget.
- `stale`: the read model is usable but older than the stale budget; show the generated timestamp and refresh affordance.
- `lagging`: a durable job checkpoint or eventual projection is behind its source head; show lag amount, reason, and retry or watch-state affordance.
- `partial`: one source, adapter, or projection is unavailable, but the read model can render a clearly marked subset.
- `unavailable`: the read model cannot be built; block the workflow and show the operator-facing error state from the query contract.

Every stale, lagging, partial, or unavailable state must include the last generated timestamp when known, a lag or source reason, and a retry or refresh affordance when retry is safe.

## Pagination Strategy

- `none`: bounded by provider adapter inventory, active profile count, section registry, or readiness rule inventory. Do not add pagination controls to these views unless the contract changes.
- `offset`: acceptable for bounded diagnostic and generated-evidence pages where the initial implementation sorts inside one provider/profile scope. Offset views still need server-side filter preservation and max limits.
- `cursor`: required for high-volume Source Observation, impact, promotion, rollback, and audit views. Use stable keyset fields such as `observedAt + observationId`, `updatedAt + observationId`, or `occurredAt + eventId`.
- `sse`: required for active job progress. Use `Last-Event-ID` semantics with `jobId + sequence` replay cursors and bounded replay windows.

High-volume views must return count summaries separately from page data when counts are needed for destructive-action confirmation. They must not scan all evidence rows just to render a first page.

## Query Shape And Index Inventory

Existing indexes and query-plan inputs used by the SLOs:

- `catalog_source_observations_provider_idx`
- `catalog_source_observations_status_idx`
- `catalog_source_observations_source_profile_idx`
- `catalog_source_observations_promotion_profile_idx`
- `catalog_source_observations_name_idx`
- `catalog_provider_integration_profile_versions_active_idx`
- `catalog_provider_integration_profile_versions_provider_idx`
- `catalog_provider_profile_version_sections_provider_idx`
- `catalog_provider_profile_version_sections_ingestion_unit_idx`
- `catalog_provider_profile_version_section_diagnostics_lookup_idx`
- `catalog_source_observation_integration_durable_jobs_status_created_idx`
- `catalog_source_observation_integration_durable_jobs_kind_status_idx`
- `catalog_source_observation_integration_job_events_lookup_idx`
- `catalog_source_observation_integration_work_units_job_state_idx`
- `catalog_source_observation_bulk_review_jobs_status_created_idx`
- `catalog_source_observation_bulk_review_work_units_job_state_idx`
- `event_store_events_context_category_type_global_idx`
- `event_store_events_context_category_global_idx`

Planned indexes required as the corresponding read models are materialized:

- `catalog_admin_adapter_diagnostics_provider_severity_idx`
- `catalog_admin_fixture_validation_unit_flow_idx`
- `catalog_admin_dry_run_evidence_unit_profile_flow_idx`
- `catalog_admin_profile_semantic_diff_unit_profile_idx`
- `catalog_source_observations_admin_replay_impact_idx`
- `catalog_source_observations_admin_review_idx`
- `catalog_source_observations_admin_scope_time_idx`
- `catalog_source_observations_admin_promotion_scope_idx`
- `catalog_source_observations_admin_profile_reference_idx`
- `catalog_admin_audit_evidence_timeline_unit_time_idx`

Source Observation review, replay/reapply impact, promotion preview, rollback/retirement impact, and audit timelines must push provider, ingestion unit, profile/version, status, and time filters into storage. Event-sourced rebuilds must follow [Event Projection Query Plans](../../../docs/architecture/event-projection-query-plans.md) and reject broad global scans during high-volume backfills.

## Rebuild And Backfill Expectations

- Projection rebuilds must page by event projection context/category indexes and record lag until the projection catches up.
- Large backfills should capture `EXPLAIN (ANALYZE, BUFFERS)` for the representative query shape before launch.
- Durable job views must preserve active job progress during deploy transitions through resumable streams and bounded replay.
- Read-model rebuilds may show `lagging` or `partial`; they should not silently collapse to empty success states.

## Verification

The Source Observations API test suite must require SLO coverage for every Admin query key, freshness-state vocabulary coverage, high-volume pagination, and critical index metadata. As implementation slices materialize planned projections or routes, add smoke or explain-plan checks for representative high-volume queries:

- Source Observation review: at least 100,000 representative rows.
- Replay/reapply, promotion, rollback, and profile reference impact: at least 50,000 representative rows per provider/profile scope where practical.
- Durable job progress: at least 10,000 job event or work-unit rows across active and completed jobs.
- Audit evidence timelines: at least 100,000 event or projection rows with context/category/time filters.
