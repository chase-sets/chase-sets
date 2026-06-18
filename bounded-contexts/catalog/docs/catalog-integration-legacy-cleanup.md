# Catalog Integration Legacy Cleanup

Catalog owns removal of pre-launch Catalog Integration Control Plane data and compatibility paths. This policy supports the Stage 0 cleanup gate, the clean-contract handoff, and the executable reset from [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md).

## Policy

The control plane has not launched. Prefer wipe and rebuild over backwards compatibility for unlaunched integration data.

Retire means complete removal of code, runtime behavior, product patterns, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions. Legacy Source Observation profile markers may remain only as reset/drop detection data before cleanup runs; they are not retained runtime compatibility paths and must not power promotion or reapply fallback behavior.

The typed inventory lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-legacy-cleanup.ts
```

## Wipeable Data Surfaces

| Surface | Action | Release expectation |
| --- | --- | --- |
| Provider profile JSON snapshots | wipe and rebuild | TCGdex, TCGplayer, and Scrydex profiles rebuild through the persisted profile version store. |
| Profile section projections and diagnostics | rebuild from profile version | Section rows and diagnostics regenerate from retained or seeded profile versions. |
| Source Observations and legacy profile references | wipe | Clean release reset leaves zero Source Observations and zero `legacy` profile markers. |
| Integration jobs, bulk review jobs, work units, and events | wipe | Job and work-unit tables are empty before launch verification. |
| Provider option query cache | wipe | Provider option query cache rows are zero after reset. |
| Learned provider option rate limits | wipe | Provider throttling cache rows are zero after reset. |
| Fixture contract metadata and payloads | retain with explicit exception | Fixture metadata remains with profile versions; raw payload retention requires [Catalog Integration Data Governance](./catalog-integration-data-governance.md) and retained-data evidence proving a clean launch capability or launch blocker with owner and expiry. |

Seeded Provider Integration Profile versions are intentional bootstrap data. Admin-authored rows or migration-evidence rows can survive reset only when release evidence names the retained-data reason.

## Legacy Path Removal

| Path | Removal expectation | Launch gate |
| --- | --- | --- |
| Transitional static profile compatibility | deleted before clean launch handoff | No `transitional-static-profile` code, rows, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, or operator instructions remain at launch. |
| Broad Provider Integration Profile patch route | deleted before rebuilt workbench acceptance | Broad raw patch code, controls, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions are removed; section-scoped typed commands are the named supported workflow. |

These paths are not normal authoring workflows and are not allowed to survive as hidden or support-only compatibility. Retiring one means completely deleting its code, runtime behavior, product pattern, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions. Adding a new retained path is launch-blocking unless the path is rebuilt as a clean launch contract with focused tests and owner-approved evidence.

Legacy Source Observation profile marker reads are deliberately excluded from retained legacy paths. They are verification queries for destructive cleanup only; runtime code must fail closed instead of treating missing or `legacy` source profile metadata as active-profile fallback.

## Raw JSON Quarantine

Normal operators should not edit raw profile JSON. Supported authoring goes through section-scoped typed commands and the provider profile section registry. Migration evidence is a normal operator workflow and saves through the `migration-evidence` section command.

## Fresh Bootstrap Expectations

After reset and bootstrap:

- active seeded Provider Integration Profile versions exist
- profile section projections exist for retained or seeded versions
- Source Observations are empty until re-imported
- integration jobs, bulk review jobs, and work units are empty
- provider option rate-limit cache rows are empty
- legacy Source Observation profile references are zero and no runtime fallback consumes them
- editable section metadata reports `rawJsonBacked=false`

## Release Checklist

Use the release checklist from `catalogIntegrationLegacyCleanupReleaseChecklist`:

1. Run the pre-launch wipe/rebuild reset and keep the before/after verification report with release evidence.
2. Verify Source Observations, integration jobs, bulk review jobs, work units, and learned provider rate limits are empty.
3. Verify legacy Source Observation profile references are zero and promotion/reapply tests fail closed when legacy markers are present.
4. Verify seeded active TCGdex, TCGplayer, and Scrydex profile versions are present after bootstrap.
5. Verify profile section projections and diagnostics rebuilt from retained or seeded profile versions.
6. Verify every editable Provider Integration Profile section reports `rawJsonBacked=false`.
7. Verify unsupported profile authoring compatibility code, controls, fixtures, seeds, and durable documentation are absent.

## Verification Queries

Use these alongside the reset verification queries:

```sql
SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';
SELECT COUNT(*) AS source_observations FROM catalog_source_observations;
SELECT COUNT(*) AS integration_jobs FROM catalog_source_observation_integration_durable_jobs;
SELECT COUNT(*) AS integration_work_units FROM catalog_source_observation_integration_work_units;
SELECT COUNT(*) AS bulk_review_jobs FROM catalog_source_observation_bulk_review_jobs;
SELECT COUNT(*) AS bulk_review_work_units FROM catalog_source_observation_bulk_review_work_units;
SELECT provider_key, profile_version, lifecycle FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';
SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;
SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;
```

## Related Behavior

- Schema compatibility policy is defined in [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md).
- Complete deletion of retired Catalog integration admin pages, modules, route/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions follows once the rebuilt workbench is accepted.
