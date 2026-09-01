# Catalog Integration Reset and Cleanup

Catalog owns pre-launch reset, cleanup, backfill, and rollback for Catalog Integration Control Plane data, plus removal of compatibility paths. The executable policies live in:

```text
bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-migration-reset.ts
scripts/check-structure/catalog-integration-legacy-cleanup.ts
```

Schema/wire compatibility and retention-by-surface rules are owned by [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md). Provider payload, fixture, and diagnostic retention, redaction, and policy/legal approval are owned by [Catalog Integration Data Governance](./catalog-integration-data-governance.md). The meaning of "retire" is the canonical complete-deletion definition in [Catalog Integration Security Privacy Launch Gate](./catalog-integration-security-privacy-launch-gate.md#retirement-meaning), enforced by `scripts/check-structure/catalog-integration-security-privacy-launch-gate.ts`, and is not restated here.

## Release Posture

The control plane has not launched, so pre-launch integration data is wiped and rebuilt by default. Backfill is required only for intentionally retained clean-launch data, launched contracts, or deploy-skew safety. Retained compatibility paths are not accepted as clean reset completion; they are launch blockers until rebuilt as clean launch contracts or completely deleted. Legacy Source Observation profile markers may remain only as reset/drop detection data before cleanup runs — they must not power promotion or reapply fallback, and runtime must fail closed instead of treating missing or `legacy` source metadata as active-profile fallback.

Every destructive staging or production/prelaunch reset must attach one backup/snapshot/export decision before execution:

- create backup/snapshot/export and record reference, owner, retention, and restore verification;
- skip backup because data loss is accepted for the named prelaunch-only Catalog integration data set, with approver and rationale;
- retain data with owner and expiry because reset is unsafe; this stops clean reset/drop completion until the retained-data exception is removed or a later destructive reset succeeds.

## Reset Mode

The reset mode is `pre-launch-wipe-and-rebuild`. The executable evidence contract is `evaluateCatalogIntegrationDataResetEvidence`; it requires dry-run counts, before/after verification reports, non-empty target table scope, operator, generated timestamp, and environment-specific approval evidence.

1. Block reset while Catalog integration or bulk review jobs are queued or running.
2. Delete integration work units, job events, jobs, bulk review work units, bulk review events, bulk review jobs, Source Observations, provider option query cache, and learned provider option rate limits.
3. Delete provider profile versions that do not carry authoring audit or migration evidence.
4. Rebuild seeded provider profile versions through the persisted profile version store.
5. Rebuild profile section rows and diagnostics from retained or seeded profile versions.
6. Run the verification queries and record the before/after report in the release checklist.

Forced active-job cleanup is allowed only for an explicit pre-launch wipe decision with approver, rationale, and active job count. Normal release reset must finish or cancel active jobs first. Production/prelaunch reset excludes customer, order, billing, auth, marketplace, inventory, and other launched bounded-context data; the only destructive targets are the tables named by `catalogIntegrationDataResetTargetTables`.

## Data Surface Policy

| Surface | Table | Reset behavior | Preserve when |
| --- | --- | --- | --- |
| Integration work units | `catalog_source_observation_integration_work_units` | delete | queued/running job is intentionally retained |
| Integration job events | `catalog_source_observation_integration_job_events` | delete | launched/audit evidence exception exists |
| Integration durable jobs | `catalog_source_observation_integration_durable_jobs` | delete | queued/running job is intentionally retained |
| Bulk review work units | `catalog_source_observation_bulk_review_work_units` | delete | queued/running review job is intentionally retained |
| Bulk review job events | `catalog_source_observation_bulk_review_job_events` | delete | launched/audit evidence exception exists |
| Bulk review jobs | `catalog_source_observation_bulk_review_jobs` | delete | queued/running review job is intentionally retained |
| Source Observations and legacy markers | `catalog_source_observations` | delete | promoted observations are needed to explain launched Catalog Items |
| Profile section diagnostics | `catalog_provider_profile_version_section_diagnostics` | rebuild | parent profile version is retained |
| Profile section projections | `catalog_provider_profile_version_sections` | rebuild | parent profile version is retained |
| Provider option query cache | `catalog_provider_option_query_cache` | delete | never by default; this is operational cache |
| Learned provider option rate limits | `catalog_tcgplayer_automation_domain_rate_limits` | delete | never by default; this is operational cache |
| Provider profile versions | `catalog_provider_integration_profile_versions` | delete and rebuild seed | authoring audit, migration evidence, or retained references exist |
| Fixture contract metadata and payloads | (with profile versions) | retain with explicit exception | raw payload retention requires [Data Governance](./catalog-integration-data-governance.md) and retained-data evidence proving a clean-launch capability or launch blocker with owner and expiry |

Seeded Provider Integration Profile versions are intentional bootstrap data. Admin-authored rows or migration-evidence rows survive reset only when release evidence names the retained-data reason.

## Legacy Path Removal

| Path | Removal expectation | Launch gate |
| --- | --- | --- |
| Transitional static profile compatibility | deleted before clean launch handoff | No `transitional-static-profile` code, rows, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, or operator instructions remain at launch. |
| Broad Provider Integration Profile patch route | deleted before rebuilt workbench acceptance | Broad raw patch code, controls, and route/API/client/read-model behavior are removed; section-scoped typed commands are the named supported workflow. |

These paths are not normal authoring workflows and must not survive as hidden or support-only compatibility. Adding a new retained path is launch-blocking unless it is rebuilt as a clean launch contract with focused tests and owner-approved evidence. Legacy Source Observation profile marker reads are deliberately excluded from retained legacy paths: they are destructive-cleanup verification queries only.

## Raw JSON Quarantine

Normal operators do not edit raw profile JSON. Supported authoring goes through section-scoped typed commands and the provider profile section registry. Migration evidence is a normal operator workflow and saves through the `migration-evidence` section command. After reset, every editable section metadata reports `rawJsonBacked=false`.

## Backfill Rules

Backfill is skipped after a clean pre-launch wipe because fresh import and bootstrap recreate the current data shape. Backfill is required only when retained data remains:

- Profile section projections: rebuild section rows, fingerprints, validation status, and diagnostics from every retained or seeded profile version.
- Source Observation profile references: retained observations must carry non-legacy `source_profile_version`, `source_mapping_fingerprint`, and `promotion_profile_version` when promoted. Runtime promotion/reapply treats missing or `legacy` metadata as blocked cleanup data; it does not fall back to an active provider profile.
- Durable job profile snapshots: retained jobs and work units keep snapshotted profile identity readable through deploy skew.
- Fixture contracts: retained fixture metadata stays with provider profile versions; payload retention follows [Data Governance](./catalog-integration-data-governance.md).

## Rollback Strategy

Rollback means activating a prior validated Provider Integration Profile version. It does not edit old observations, job payloads, work units, or audit events.

1. Stop or cancel queued/running Catalog integration and bulk review jobs before reset or rollback.
2. Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.
3. Let already-queued integration jobs finish against their snapshotted profile version, or cancel and re-enqueue them.
4. Run a narrow import or reapply after rollback and compare Source Observation counts, diagnostics, and promotion plans.
5. Rebuild profile section projections from the retained/active profile version and verify no legacy profile references remain.

## Fresh Bootstrap Expectations

After a clean pre-launch reset and bootstrap:

- Seeded active TCGdex, TCGplayer, and Scrydex provider profile versions exist, each with exactly one active version.
- Profile section projections and diagnostics rebuilt from retained or seeded versions.
- Source Observations are empty until re-imported.
- Integration jobs, bulk review jobs, and work units are empty.
- Provider option query cache rows and learned provider rate-limit rows are empty.
- Legacy Source Observation profile references are zero and no runtime fallback consumes them.
- Editable section metadata reports `rawJsonBacked=false`.

## Release Checklist

Use the checklist from `catalogIntegrationLegacyCleanupReleaseChecklist`:

1. Run the pre-launch wipe/rebuild reset and keep the before/after verification report with release evidence.
2. Verify Source Observations, integration jobs, bulk review jobs, work units, and learned provider rate limits are empty.
3. Verify legacy Source Observation profile references are zero and promotion/reapply tests fail closed when legacy markers are present.
4. Verify seeded active TCGdex, TCGplayer, and Scrydex profile versions are present after bootstrap.
5. Verify profile section projections and diagnostics rebuilt from retained or seeded profile versions.
6. Verify every editable Provider Integration Profile section reports `rawJsonBacked=false`.
7. Verify unsupported profile authoring compatibility code, controls, fixtures, seeds, and durable documentation are absent.

Post-reset evidence is not accepted while Source Observations, legacy markers, integration jobs/work units, bulk review jobs/work units, provider option query cache rows, learned provider rate limits, or missing seeded active profiles remain.

## Verification Queries

Run these before and after reset:

```sql
SELECT COUNT(*) AS provider_profile_versions FROM catalog_provider_integration_profile_versions;
SELECT COUNT(*) AS active_provider_profiles FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';
SELECT provider_key, profile_version, lifecycle FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';
SELECT COUNT(*) AS source_observations FROM catalog_source_observations;
SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';
SELECT status, COUNT(*) AS jobs FROM catalog_source_observation_integration_durable_jobs GROUP BY status ORDER BY status;
SELECT state, COUNT(*) AS work_units FROM catalog_source_observation_integration_work_units GROUP BY state ORDER BY state;
SELECT COUNT(*) AS bulk_review_jobs FROM catalog_source_observation_bulk_review_jobs;
SELECT COUNT(*) AS bulk_review_work_units FROM catalog_source_observation_bulk_review_work_units;
SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;
SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;
SELECT COUNT(*) AS provider_option_query_cache_entries FROM catalog_provider_option_query_cache;
SELECT COUNT(*) AS provider_option_rate_limits FROM catalog_tcgplayer_automation_domain_rate_limits;
```
