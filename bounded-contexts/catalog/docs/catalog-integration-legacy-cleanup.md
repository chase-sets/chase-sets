# Catalog Integration Legacy Cleanup

Catalog owns removal of pre-launch Catalog Integration Control Plane data and compatibility paths. This policy implements #804 and uses the executable reset from [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md).

## Policy

The control plane has not launched. Prefer wipe and rebuild over backwards compatibility for unlaunched integration data.

Retain a legacy path only when it has:

- owner
- reason
- removal date
- removal criteria
- launch gate

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
| Learned provider option rate limits | wipe | Provider throttling cache rows are zero after reset. |
| Fixture contract metadata and payloads | retain with explicit exception | Fixture metadata remains with profile versions; raw payload retention requires #794/#803 governance and #804 retained-data evidence. |

Seeded Provider Integration Profile versions are intentional bootstrap data. Admin-authored rows or migration-evidence rows can survive reset only when release evidence names the retained-data reason.

## Retained Legacy Paths

| Path | Owner issue | Removal date | Launch gate |
| --- | --- | --- | --- |
| Transitional static profile compatibility | #804 | 2026-06-30 | No `transitional-static-profile` row may launch without fixture coverage and a retirement plan. |
| Legacy Source Observation profile marker reads | #804 | 2026-06-30 | `legacy_source_observation_references` returns zero after reset. |
| Broad Provider Integration Profile patch route | #789 | 2026-06-30 | Normal Admin workflows expose only section-scoped typed editors with `rawJsonBacked=false`. |

These paths are compatibility exceptions, not normal authoring workflows. Adding a new retained path requires updating the typed inventory, this document, and focused tests.

## Raw JSON Quarantine

Normal operators should not edit raw profile JSON. Supported authoring goes through section-scoped typed commands and the provider profile section registry.

The broad profile patch route remains quarantined for controlled internal or migration compatibility while #789 retires raw JSON fallback paths. Normal calls receive `raw_profile_patch_quarantined` and must move to the relevant typed section command. The only accepted compatibility request shape is:

```json
{
  "patch": {},
  "rawJsonQuarantine": {
    "ownerIssue": 789,
    "reason": "Controlled internal compatibility or migration operation.",
    "retirementCondition": "section-scoped-typed-commands-complete"
  }
}
```

This route must not become the normal Admin Control Plane workflow for profile authoring, validation, dry-run, activation, import, promotion/reapply, rollback, migration evidence, or retirement. Migration evidence is a normal operator workflow and saves through the `migration-evidence` section command.

## Fresh Bootstrap Expectations

After reset and bootstrap:

- active seeded Provider Integration Profile versions exist
- profile section projections exist for retained or seeded versions
- Source Observations are empty until re-imported
- integration jobs, bulk review jobs, and work units are empty
- provider option rate-limit cache rows are empty
- legacy Source Observation profile references are zero
- editable section metadata reports `rawJsonBacked=false`
- any transitional static profile has a retirement plan

## Release Checklist

Use the release checklist from `catalogIntegrationLegacyCleanupReleaseChecklist`:

1. Run the pre-launch wipe/rebuild reset and keep the before/after verification report with release evidence.
2. Verify Source Observations, integration jobs, bulk review jobs, work units, and learned provider rate limits are empty.
3. Verify legacy Source Observation profile references are zero.
4. Verify seeded active TCGdex, TCGplayer, and Scrydex profile versions are present after bootstrap.
5. Verify profile section projections and diagnostics rebuilt from retained or seeded profile versions.
6. Verify every editable Provider Integration Profile section reports `rawJsonBacked=false`.
7. Verify the broad profile patch route rejects normal calls with `raw_profile_patch_quarantined` and accepts only explicit #789 compatibility metadata, or is removed before launch.
8. Verify every retained transitional compatibility path has owner, reason, removal date, and launch gate.

## Verification Queries

Use these alongside the reset verification queries:

```sql
SELECT COUNT(*) AS legacy_source_observation_references FROM catalog_source_observations WHERE source_profile_version = 'legacy' OR source_mapping_fingerprint = 'legacy' OR promotion_profile_version = 'legacy';
SELECT COUNT(*) AS source_observations FROM catalog_source_observations;
SELECT COUNT(*) AS integration_jobs FROM catalog_source_observation_integration_durable_jobs;
SELECT COUNT(*) AS integration_work_units FROM catalog_source_observation_integration_work_units;
SELECT COUNT(*) AS bulk_review_jobs FROM catalog_source_observation_bulk_review_jobs;
SELECT COUNT(*) AS bulk_review_work_units FROM catalog_source_observation_bulk_review_work_units;
SELECT provider_key, profile_version, retirement_plan_json FROM catalog_provider_integration_profile_versions WHERE compatibility_mode = 'transitional-static-profile';
SELECT provider_key, profile_version, lifecycle FROM catalog_provider_integration_profile_versions WHERE active = true AND lifecycle = 'active';
SELECT COUNT(*) AS profile_sections FROM catalog_provider_profile_version_sections;
SELECT COUNT(*) AS profile_section_diagnostics FROM catalog_provider_profile_version_section_diagnostics;
```

## Related Issues

- #789 retires raw JSON fallback authoring paths.
- #792 provides executable pre-launch reset.
- #793 owns schema compatibility policy.
- #804 owns this legacy cleanup inventory and retained-path policy.
