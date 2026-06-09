# Catalog Integration Data Migration Reset

Catalog owns migration, reset, backfill, and rollback behavior for Catalog Integration Control Plane data. The executable policy lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-migration-reset.ts
```

This plan implements #792, consumes the compatibility policy from [Catalog Integration Schema Compatibility](./catalog-integration-schema-compatibility.md), and uses the retained-path inventory from [Catalog Integration Legacy Cleanup](./catalog-integration-legacy-cleanup.md).

## Release Posture

The control plane has not launched, so pre-launch integration data should be wiped and rebuilt by default. Compatibility or backfill is required only for intentionally retained data, launched contracts, deploy-skew safety, or a documented #804 retained-data exception with owner, reason, removal date, removal criteria, and launch gate.

For legacy or compatibility cleanup, "retire" means complete removal of the code path, supporting patterns, references, and documentation. It does not mean hiding a fallback, keeping a compatibility shim, or preserving an undocumented recovery path.

Every destructive staging or production/prelaunch reset must attach one backup/snapshot/export decision before execution:

- create backup/snapshot/export and record reference, owner, retention, and restore verification;
- skip backup because data loss is accepted for the named prelaunch-only Catalog integration data set, with approver and rationale;
- retain data with owner and expiry because reset is unsafe; this stops clean reset/drop completion until the retained-data exception is removed or a later destructive reset succeeds.

The executable evidence contract is `evaluateCatalogIntegrationDataResetEvidence`. It requires dry-run counts, before/after verification reports, non-empty target table scope, operator, generated timestamp, and environment-specific approval evidence. Local/dev/test can skip backup evidence; staging and production/prelaunch cannot. Staging also requires a smoke verification reference. Production/prelaunch requires both the successful staging rehearsal reference and production smoke verification reference.

The reset mode is `pre-launch-wipe-and-rebuild`:

1. Block reset while Catalog integration or bulk review jobs are queued or running.
2. Delete integration work units, job events, jobs, bulk review work units, bulk review events, bulk review jobs, Source Observations, provider option query cache, and learned provider option rate limits.
3. Delete provider profile versions that do not carry authoring audit or migration evidence.
4. Rebuild seeded provider profile versions through the persisted profile version store.
5. Rebuild profile section rows and diagnostics from retained or seeded profile versions.
6. Run verification queries and record the before/after report in the release checklist.

Forced active-job cleanup is allowed only for explicit pre-launch wipe decisions. Normal release reset must finish or cancel active jobs first.

## Data Surface Policy

| Surface | Table | Reset behavior | Preserve when |
| --- | --- | --- | --- |
| Integration work units | `catalog_source_observation_integration_work_units` | delete | queued/running job is intentionally retained |
| Integration job events | `catalog_source_observation_integration_job_events` | delete | launched/audit evidence exception exists |
| Integration durable jobs | `catalog_source_observation_integration_durable_jobs` | delete | queued/running job is intentionally retained |
| Bulk review work units | `catalog_source_observation_bulk_review_work_units` | delete | queued/running review job is intentionally retained |
| Bulk review job events | `catalog_source_observation_bulk_review_job_events` | delete | launched/audit evidence exception exists |
| Bulk review jobs | `catalog_source_observation_bulk_review_jobs` | delete | queued/running review job is intentionally retained |
| Source Observations | `catalog_source_observations` | delete | promoted observations are needed to explain launched Catalog Items |
| Profile section diagnostics | `catalog_provider_profile_version_section_diagnostics` | rebuild | parent profile version is retained |
| Profile section projections | `catalog_provider_profile_version_sections` | rebuild | parent profile version is retained |
| Provider option query cache | `catalog_provider_option_query_cache` | delete | never by default; this is operational cache |
| Provider option rate limits | `catalog_tcgplayer_automation_domain_rate_limits` | delete | never by default; this is operational cache |
| Provider profile versions | `catalog_provider_integration_profile_versions` | delete and rebuild seed | authoring audit, migration evidence, or retained references exist |

## Environment Evidence

| Environment | Backup decision | Approval | Required evidence |
| --- | --- | --- | --- |
| Local/dev/test | Optional | Not required | dry-run counts, before/after report, seeded profile rebuild result |
| Staging | Required | Required | backup/export decision, approval reference, dry-run counts, before/after report, staging smoke verification |
| Production/prelaunch | Required | Required | backup/export decision or accepted data-loss approval, production/prelaunch approval reference, dry-run counts, before/after report, staging rehearsal reference, production smoke verification |

Production/prelaunch reset excludes customer, order, billing, auth, marketplace, inventory, unrelated audit, and other launched bounded-context data. The only destructive targets are the tables named by `catalogIntegrationDataResetTargetTables`.

Forced cleanup of queued/running integration or bulk review jobs requires an explicit forced prelaunch wipe decision with approver, rationale, and active job count. Otherwise active jobs block reset.

## Backfill Rules

Backfill is skipped after a clean pre-launch wipe because fresh import and bootstrap recreate the current data shape.

Backfill is required only when retained data remains:

- Profile section projections: rebuild section rows, fingerprints, validation status, and diagnostics from every retained or seeded profile version.
- Source Observation profile references: retained observations must carry non-legacy `source_profile_version`, `source_mapping_fingerprint`, and `promotion_profile_version` when promoted.
- Runtime promotion/reapply treats missing or `legacy` Source Observation profile metadata as blocked cleanup data; it does not fall back to an active provider profile.
- Durable job profile snapshots: retained jobs and work units must keep snapshotted profile identity readable through deploy skew.
- Fixture contracts: retained fixture metadata stays with provider profile versions; fixture payload retention must follow [Catalog Integration Data Governance](./catalog-integration-data-governance.md).

## Rollback Strategy

Rollback means activating a prior validated Provider Integration Profile version. It does not edit old observations, job payloads, work units, or audit events.

Release rollback checklist:

1. Stop or cancel queued/running Catalog integration and bulk review jobs before reset or rollback.
2. Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.
3. Let already queued integration jobs finish against their snapshotted profile version, or cancel and re-enqueue them.
4. Run a narrow import or reapply after rollback and compare Source Observation counts, diagnostics, and promotion plans.
5. Rebuild profile section projections from the retained/active profile version and verify no legacy profile references remain.

## Verification Queries

Use these queries before and after reset:

```sql
SELECT COUNT(*) AS provider_profile_versions FROM catalog_provider_integration_profile_versions;
SELECT COUNT(*) AS active_provider_profiles FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';
SELECT COUNT(*) AS source_observations FROM catalog_source_observations;
SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';
SELECT status, COUNT(*) AS jobs FROM catalog_source_observation_integration_durable_jobs GROUP BY status ORDER BY status;
SELECT state, COUNT(*) AS work_units FROM catalog_source_observation_integration_work_units GROUP BY state ORDER BY state;
SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;
SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;
SELECT COUNT(*) AS provider_option_query_cache_entries FROM catalog_provider_option_query_cache;
SELECT COUNT(*) AS provider_option_rate_limits FROM catalog_tcgplayer_automation_domain_rate_limits;
```

Expected clean pre-launch reset result:

- Seeded provider profile versions are present.
- TCGdex, TCGplayer, and Scrydex provider setup can be recreated through the persisted profile version store.
- Each seeded active provider has exactly one active profile version.
- Source Observations are empty until re-imported.
- Integration and bulk review job/work-unit tables are empty.
- Provider option query cache rows and learned provider rate limits are empty.
- Legacy Source Observation profile references are zero.
- Profile section projections exist for retained or seeded profile versions.
- Normal Admin profile authoring uses section-scoped typed commands with `rawJsonBacked=false`.

Post-reset evidence is not accepted while Source Observations, legacy Source Observation profile markers, integration jobs/work units, bulk review jobs/work units, provider option query cache rows, learned provider rate limits, or missing seeded active profiles remain.

## Relationship To Adjacent Issues

- #804 owns retained-data exceptions, release cleanup inventory, and removal of legacy compatibility code in [Catalog Integration Legacy Cleanup](./catalog-integration-legacy-cleanup.md).
- [Catalog Integration Data Governance](./catalog-integration-data-governance.md) owns provider payload, fixture, dry-run, diagnostic retention, redaction, and policy/legal signoff.
- #791 owns job idempotency and deploy-skew behavior.
- #793 owns wire schema compatibility policy and retained-data rules by surface.
