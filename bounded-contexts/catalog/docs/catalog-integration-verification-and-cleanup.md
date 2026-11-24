# Catalog Integration Verification and Cleanup

## Production Disposition

The one-time Catalog Integration reset was retired. Production apply is **NOT RUN**, not PASS, and will not be applied. The [November 22 disposition for #1900 Launch readiness: catalog integration prelaunch reset & complete old-surface removal](https://github.com/chase-sets/chase-sets/issues/1900#issuecomment-7074059802) binds the decision to the [production read-only inventory](https://github.com/chase-sets/chase-sets/actions/runs/44984051710) at `f890cd6f`. The inventory recorded a managed Postgres backup reference and zero Source Observations, observation streams, active integration or bulk-review jobs, and protected promotion provenance. Apply would only have removed 39 provider profile versions, 15 cache rows, and four learned rate-limit rows. Those are November 22 counts, not current production evidence.

Historical staging [apply](https://github.com/chase-sets/chase-sets/actions/runs/29661390006) and [smoke](https://github.com/chase-sets/chase-sets/actions/runs/29675148716) are retained as rehearsal evidence only. The [archived record](./catalog-integration-production-reset-disposition.json) is required by the [security/privacy launch gate](./catalog-integration-security-privacy-launch-gate.md). Neither the rehearsal nor the production dry-run establishes retained-data readability or release signoff.

## Retained-Data Verification

The release verifier captures read-only profile and job readbacks and links staging and private production smoke to the deployed release. Unknown or failed proof blocks signoff. No reset, backup/restore, or restore-point deletion is a closeout step.

Use `collectCatalogIntegrationDataVerificationReport` for counts and `catalogIntegrationLegacyCleanupReleaseChecklist` for the retained-data checklist. Verify active profiles and profile sections remain readable, job readbacks retain their snapshotted profile versions, and legacy markers are absent. Persisted legacy or missing profile metadata must not resolve to an active-profile fallback during deployment skew. Nonzero retained observations, terminal job history, caches, and learned rate limits do not by themselves require cleanup.

## Legacy Path Removal

| Path | Removal expectation | Launch gate |
| --- | --- | --- |
| Transitional static profile compatibility | deleted before clean launch handoff | No `transitional-static-profile` code, rows, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, or operator instructions remain at launch. |
| Broad Provider Integration Profile patch route | deleted before rebuilt workbench acceptance | Broad raw patch code, controls, and route/API/client/read-model behavior are removed; section-scoped typed commands are the named supported workflow. |

These paths are not normal authoring workflows and must not survive as hidden or support-only compatibility. Adding a new retained path is launch-blocking unless it is rebuilt as a clean launch contract with focused tests and owner-approved evidence. Legacy Source Observation profile marker reads are deliberately excluded from retained legacy paths: they are read-only cleanup verification queries, not runtime fallback.

## Raw JSON Quarantine

Normal operators do not edit raw profile JSON. Supported authoring goes through section-scoped typed commands and the provider profile section registry. Migration evidence is a normal operator workflow and saves through the `migration-evidence` section command. The command takes only what the operator writes, the evidence text (refused when blank) and an optional fixture run; Catalog stamps when it was recorded, who recorded it and for which account, and the before and after mapping fingerprints from the active and candidate versions. Every editable section metadata reports `rawJsonBacked=false`.

## Rollback Strategy

Rollback means activating a prior validated Provider Integration Profile version. It does not edit old observations, job payloads, work units, or audit events.

1. Stop or cancel queued/running Catalog integration and bulk review jobs before rollback.
2. Activate the prior validated Provider Integration Profile version instead of editing historical profile rows.
3. Let already-queued integration jobs finish against their snapshotted profile version, or cancel and re-enqueue them.
4. Run a narrow import or reapply after rollback and compare Source Observation counts, diagnostics, and promotion plans.
5. Rebuild profile section projections from the retained/active profile version and verify no legacy profile references remain.

## Verification Queries

Use these read-only queries for retained-data evidence:

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
