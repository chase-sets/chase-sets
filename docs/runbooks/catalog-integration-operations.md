# Catalog Integration Operations

Use this runbook for Catalog Integration Control Plane incidents involving provider adapters, option queries, fixture validation, activation readiness, import/reapply jobs, bulk review jobs, promotion/reapply failures, and Source Observation read-model lag.

## First Checks

1. Confirm deploy health:
   - `https://admin.chasesets.com/api/health/ready`
   - worker status endpoint for the active environment.
2. Open Grafana `Catalog Integration Control Plane` (`chase-sets-catalog-control-plane`) and inspect:
   - Catalog option query failures and degraded cache use.
   - Catalog integration job outcomes.
   - control-plane blocker, support detour, and read-model freshness events.
   - worker run count/duration for Catalog job runners and projection metrics when freshness is implicated.
3. Open Admin Control Plane:
   - `/catalog/integrations`
   - provider, ingestion unit, and Source scope selectors
   - source option cache freshness and reload/force-refresh controls
   - readiness summary
   - active jobs
   - diagnostic counts
   - provider transport readiness
4. Check logs in Loki by stable `type`, provider key, and diagnostic code. Do not search for or paste raw provider payloads or credentials.

## Provider Adapter Auth Failure

Symptoms:

- Admin readiness shows credential missing, invalid, expired, revoked, or authentication failed.
- Option queries or imports fail for one provider.
- Logs show credential-readiness or adapter-authentication diagnostics.

Triage:

1. Confirm whether the provider requires credentials for the affected unit.
2. Verify the credential secret exists in the environment and has not expired or been revoked.
3. Rotate or refresh the credential through the provider-owned secret process.
4. Run a bounded readiness or option-query smoke after rotation.
5. Confirm no logs, metrics, or Admin copy exposed the credential material.

Do not:

- paste credentials into issue comments, logs, fixtures, profile sections, or Admin copy;
- store provider cookies or tokens in profile JSON;
- bypass Source Observations by calling Catalog write APIs directly.

## Provider API Outage Or Rate-Limit Pressure

Symptoms:

- Elevated option-query failure metrics.
- `degraded=true` option-query metrics and stale cache served.
- Adapter diagnostics mention reachability, 429, retry-after, cooldown, 502, 503, or 504.
- Import jobs move slowly or fail with provider transport diagnostics.

Triage:

1. Identify provider and query/import scope from bounded labels and Admin readiness.
2. Check whether cache-only rollout mode is enabled for provider option queries.
3. Prefer stale cache for selector reads when within stale TTL. The operator should still select the source scope from the guided controls and see stale/cache-only status inline.
4. Pause imports if provider cooldown or outage would create repeated failed jobs.
5. Resume with a small scope after retry-after/cooldown has passed.

Escalate when:

- stale cache is unavailable for required import selectors;
- provider downtime exceeds the stale option-query window;
- repeated import attempts fail after provider recovery.

## Guided TCGdex Scope Sync

Use this path when validating or recovering the common Japanese Pokemon set import:

1. Open `/catalog/integrations` and choose provider `TCGdex` with the Pokemon single-card Source Observation ingestion unit.
2. Load provider source options. If the provider is degraded, use the stale/cache-only option pages only when they are still inside the stale window and clearly labeled in the UI.
3. In Source scope, select Language `Japanese`, Series `SV`, and Expansion `SV8`. Use `Select source scope`; do not type or paste a serialized scope string.
4. Run `Pull provider data`. If an active job conflict appears for the same provider/unit/scope, monitor, cancel, or let the active job finish before starting another pull.
5. After the job completes, confirm the selected scope shows observed or changed Source Observation rows.
6. Spot check Source Observation provenance, redaction, normalized card facts, and promotion readiness.
7. Preview promotion for the selected scope.
8. Use `Promote all eligible in this scope` only after the confirmation summary names the selected scope and eligible count.

## Fixture Validation Failure Before Activation

Symptoms:

- Activation readiness is blocked by fixture or dry-run diagnostics.
- Admin compare/dry-run views show fixture coverage gaps or changed normalized facts.

Triage:

1. Inspect diagnostic code, fixture flow, profile version, and section path.
2. Confirm fixture files follow [Catalog Integration Fixture Lifecycle](../../bounded-contexts/catalog/docs/catalog-integration-fixture-lifecycle.md).
3. Re-run dry run against the named fixture flow.
4. Fix profile section semantics or fixture expectations.
5. Keep raw provider payload changes governed by [Catalog Integration Data Governance](../../bounded-contexts/catalog/docs/catalog-integration-data-governance.md).

Do not activate a profile while activation-blocking diagnostics remain.

## Activation Blocked By Diagnostics

Symptoms:

- Profile activation, rollback, deprecation, or retirement is blocked.
- Impact analysis reports active jobs, missing fixtures, migration gaps, or read-model lag.

Triage:

1. Review lifecycle impact and readiness diagnostics.
2. Resolve active import/reapply/promotion jobs first.
3. Confirm fixture coverage, dry-run status, credential readiness, rollout controls, and migration/reset evidence.
4. Re-run readiness after remediation.
5. Activate only when blocking diagnostics are cleared or an explicit release exception is documented.

## Import Job Stuck Or Failed

Symptoms:

- Active import job stays running without progress.
- Worker metrics show no Catalog job processing while queued work exists.
- Job events stop advancing.
- Job result contains failed outcomes.

Triage:

1. Check platform worker health and runner capacity.
2. Inspect `catalog.source-observation-integration-jobs` runner activity.
3. Confirm worker job processing rollout control is enabled.
4. Check provider adapter diagnostics for outage, auth, or rate limit.
5. If a lease was lost during deploy, wait for durable job handoff before retrying.
6. Retry only after provider/readiness blockers are resolved.

Use projection operations runbooks when job views are stale but worker/job tables are progressing.

## Promotion Or Reapply Failure

Symptoms:

- Bulk review work-unit failure metrics increase.
- Admin Source Observation review shows failed promote, reject, or reapply outcomes.
- Promotion plans show blocked duplicate, selected-option, external-reference, reference-hierarchy, or mapping diagnostics.

Triage:

1. Inspect the diagnostic code and promotion/reapply plan.
2. Confirm the Source Observation status is eligible.
3. Check active profile version and conflict precedence policy.
4. Resolve missing Catalog reference data or selected Option mappings.
5. Re-run preview/impact before retrying a bulk action.

Do not manually patch Catalog Items outside the engine-generated promotion/reapply plan unless the release lead records a break-glass exception.

## Projection Or Read-Model Lag

Symptoms:

- Admin readiness/read models show `lagging`, `partial`, or `unavailable`.
- Projection metrics show failures or high duration.
- Projection Operations reports blocked streams.

Triage:

1. Open [Projection Operations](./projection-operations.md).
2. Identify affected projection/read-model key.
3. Retry blocked stream when the handler failure is fixed and replay-safe.
4. Rebuild only the affected projection group when retry is insufficient.
5. Verify Admin status returns to `fresh` or acceptable `stale`.

## Release Evidence

For each Catalog integration incident or release hardening pass, record:

- provider and ingestion unit;
- diagnostic codes and severity;
- metric names and bounded labels used;
- whether stale/cache-only mode was used;
- job or work-unit outcome summary without job ids or observation ids in metric labels;
- redaction check result;
- remediation and verification date.

For pre-launch data reset/drop runs, also record:

- environment plan from `catalogIntegrationDataResetEnvironmentPlans`;
- backup/snapshot/export decision or accepted data-loss approval;
- approval reference for staging or production/prelaunch;
- dry-run counts and before/after `collectCatalogIntegrationDataVerificationReport` output;
- non-empty exact target tables from `catalogIntegrationDataResetTargetTables`;
- forced active-job cleanup decision when queued/running jobs are intentionally wiped;
- `evaluateCatalogIntegrationDataResetEvidence` result;
- successful staging rehearsal reference for production/prelaunch resets;
- staging or production smoke verification reference.

Use `pnpm run ops catalog:integration-reset -- --action dry-run` through the
`Catalog Integration Staging Reset` workflow to collect staging counts without
mutation. The workflow resolves the staging Catalog database from reviewed
Terraform state, verifies the connected database is exactly
`chase_sets_staging_catalog`, and emits the exact non-empty policy target scope.

Destructive staging apply requires the exact confirmation phrase
`reset staging catalog integration data`, a support-safe operator, an approval
reference, and either complete backup evidence or a complete accepted-data-loss
decision. The command runs the staging-refresh overlap-only gate immediately
before mutation and always invokes the policy with active-job reset disabled.
`production-prelaunch` is recognized but refused; production requires separate
reviewed machinery after a successful staging rehearsal.

For the Catalog Scope Registry / Merge Candidate v2 destructive reset (`catalog-scope-merge-candidate-reset.ts`, #3807, required before #3794/#3799 deploy), also record:

- dry-run and before/after counts from `collectCatalogScopeMergeCandidateVerificationReport`, covering Merge Candidates, Merge Candidate observations, `catalog.merge-candidate-*` event streams/events, and unreviewed Provider Scope Mapping proposals;
- after migration `20260713_catalog_merge_candidate_scope_identity_v2`, the unfiltered `POST /merge-candidates/generate` response's `observationCount`, `matchedObservationCount`, `excludedObservationCount`, and `candidateCount`; every exclusion must carry `unmapped-provider-scope` or `ambiguous-provider-scope` evidence and be routed to Provider Scope Mapping review before it can enter a candidate;
- non-empty exact targets from `catalogScopeMergeCandidateResetTargetTables`;
- confirmation that preserved surfaces (`catalog_scope_records`, reviewed Provider Scope Mappings, `catalog_source_observations`, promoted Catalog Items) are row-count identical before and after — `resetCatalogMergeCandidateDerivedState` throws instead of committing if not;
- `evaluateCatalogScopeMergeCandidateResetEvidence` result;
- rebuild evidence (`observationsConsidered`, `candidatesCreated`) from `generateCatalogMergeCandidates` for staging/production resets, per `catalogScopeMergeCandidateRebuildChecklist`.

When a legacy or compatibility path is retired, remove the code, patterns, and documentation completely. Do not leave fallback branches, compatibility shims, dual-path docs, or operator instructions for the retired path.
