# Catalog Integration Schema Compatibility

Catalog owns schema compatibility for the Catalog Integration Control Plane surfaces that turn provider facts into Source Observations, review evidence, promotion plans, and Admin Control Plane state.

This policy distinguishes three kinds of change:

- Semantic data version: a provider/profile/mapping marker that changes what Catalog facts mean, such as `profileVersion`, `sourceMappingFingerprint`, or connector source version.
- Wire schema version: the DTO or persisted payload shape used by APIs, jobs, projections, diagnostics, or fixtures.
- Launch retention policy: whether old data is intentionally retained or can be reset because the control plane has not launched.

The authoritative typed policy lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-schema-compatibility.ts
```

Pre-launch cleanup, the executable migration/reset policy, and the reset evidence contract are owned by [Catalog Integration Reset and Cleanup](./catalog-integration-reset-and-cleanup.md), implemented in:

```text
bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-migration-reset.ts
scripts/check-structure/catalog-integration-legacy-cleanup.ts
```

## Launch Boundary

Pre-launch integration-control-plane data should be reset or rebuilt by default. Do not add compatibility adapters for old profile, payload, fixture, or job shapes unless a retained-data evidence packet proves a clean launch capability or a launch blocker with owner, reason, expiry/removal criteria, and verification. Retired compatibility paths are not retained data; they must be completely deleted from code, product patterns, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions.

Compatibility is required for:

- active, deprecated, retired, or otherwise referenced Provider Integration Profile versions
- intentionally retained Source Observations
- queued or running durable integration jobs and work units
- launched Admin Control Plane read-model DTOs
- diagnostic codes and blocking behavior used by operators or tests
- audit/evidence records
- API/worker deploy skew while a job is already enqueued

## Compatibility Matrix

| Surface | Current wire schema | Semantic markers | Retention | Deploy skew |
| --- | --- | --- | --- | --- |
| ProviderAdapter contract and capabilities | `catalog-provider-adapter-v1` | adapter key, capabilities, supported scopes | launched contract | request-time current code |
| Provider payload/provenance envelope | `catalog-provider-payload-provenance-v1` | provider key, connector kind, connector source version, source URL | resettable pre-launch | request-time current code |
| Provider Integration Profile version | `catalog-provider-profile-version-v1` | provider key, profile key, profile version, ingestion-unit key | retain when referenced | read old, write current |
| Profile section command/projection | `catalog-profile-section-command-v1` | section key, section fingerprint, profile version | resettable pre-launch | read old, write current |
| Executable mapping contract | `catalog-executable-mapping-contract-v1` | provider key, profile key, profile version, source mapping fingerprint | retain when referenced | read old, write current |
| Catalog Integration Engine I/O | `catalog-integration-engine-io-v1` | unit key, provider key, profile version, source mapping fingerprint | resettable pre-launch | request-time current code |
| Diagnostic record | `catalog-integration-diagnostic-v1` | code, severity, blocking behavior, visibility | launched contract | read old, write current |
| Fixture contract | `catalog-fixture-contract-v1` | fixture set version, required flows, profile version | resettable pre-launch | read old, write current |
| Admin Control Plane read model | `catalog-admin-control-plane-read-model-v1` | query key, unit key, generated timestamp | launched contract | projection can lag |
| Source Observation record | `catalog-source-observation-record-v1` | provider key, source profile version, source mapping fingerprint, promotion profile version | reset/drop when markers are missing or `legacy` | require explicit profile metadata |
| Integration durable job | `catalog-integration-durable-job-v1` | job kind, action, profile snapshot including ingestion-unit key, reapply profile mode, optional parent `syncRunId` | reset/drop when reapply profile mode or snapshot metadata is missing | snapshot at enqueue |
| Integration work unit | `catalog-integration-work-unit-v1` | job ID, unit ID, profile snapshot including ingestion-unit key, reapply profile mode | reset/drop when reapply profile mode or snapshot metadata is missing | snapshot at enqueue |
| Audit/evidence record | `catalog-audit-evidence-record-v1` | event name, provider key, profile version, related job, related observation | launched contract | projection can lag |

## Rules By Surface

Provider adapters may add optional capabilities or diagnostics additively. A required capability change must include fixture-backed readiness diagnostics for old adapters and must not add provider-specific branches to Catalog runtime, API routes, Admin pages, or promotion/reapply code.

Provider payload bodies, sampled payloads, and fixture payloads are not Catalog truth. Retaining payload bodies requires [Catalog Integration Data Governance](./catalog-integration-data-governance.md) approval and a retained-data exception. Logs, metrics, diagnostics, and audit evidence must use redacted summaries or stable references instead of raw provider payloads.

Provider Integration Profile versions remain readable while referenced by Source Observations, jobs, rollback/deprecation history, or audit evidence. Bootstrap may preserve admin-authored profile rows only when retained-data evidence proves a clean launch capability or launch blocker; unreferenced pre-launch rows can be reset by the prelaunch reset/drop plan.

Profile version rows carry `ingestion_unit_key` as typed read-model identity. The active uniqueness rule is `(provider_key, ingestion_unit_key)` for rows where `active = true` and `lifecycle = 'active'`, so unrelated active units for the same provider can coexist. Runtime activation still compares preserved rows through the typed profile/unit helper so older retained rows without the column populated are not silently skipped.

Executable mapping contract changes are semantic compatibility changes when they alter Source Observation external keys, source hash material, selected Options, external references, Reference Record targets, duplicate-prevention order, or promotion command plans. Activation requires migration evidence when the mapping fingerprint changes in a breaking way.

Durable integration jobs and work units snapshot profile identity at enqueue time. Worker/API deploy skew must not switch a queued job to a newer active profile. Catalog sync parent runs use the existing integration durable-job table with job kind `catalog-sync-scope`; child provider import jobs may add an optional `syncRunId` payload field, and older child jobs without that field remain valid. Reapply jobs without `reapplyProfileMode` or profile snapshot metadata are pre-launch cleanup data and must be reset/dropped instead of defaulting to `original-source-profile`.

Provider option-query cache identity includes provider key, profile key, profile version, ingestion-unit key, query kind, language code, and parent value. Same-provider option queries for different active units must not share cache entries even when the provider and profile version string are the same.

Admin read models evolve additively. They must expose stale, degraded, empty, or blocked states instead of forcing UI modules to parse profile JSON, job payload JSON, or provider-specific snapshots.

Audit and diagnostic records are launched operator evidence. They must remain readable after projection rebuilds and must follow [Catalog Integration Data Governance](./catalog-integration-data-governance.md) for payload summaries.

## Reset And Migration Policy

Use reset/rebuild when all of these are true:

- the data was created before the control plane launched
- no launched contract or retained-data exception references it
- no active/queued durable job depends on it
- no Source Observation, promotion, audit, or rollback workflow needs it for explanation

Use additive compatibility or migration only when at least one of these is true:

- the data is launched or intentionally retained
- an active, deprecated, retired, or audit-referenced profile version needs to be read
- a queued/running durable job or work unit was created before deployment
- the Admin UI or an operator journey consumes the DTO as a stable contract
- a future provider addition needs an additive semantic primitive or adapter capability

Do not use this policy to keep retired code, patterns, or documentation alive. A retired compatibility path must be completely deleted from runtime code, UI, routes, API/read-model contracts, clients, feature flags, aliases, compatibility shims, migration shims, fixtures, seeds, screenshots, tests, documentation, runbooks, release notes, and operator instructions.

The pre-launch reset mode deletes integration jobs, work units, Source Observations, learned provider option rate limits, and non-admin-authored provider profile versions, then rebuilds seeded profile versions and section projections. Active jobs block reset unless an operator records an explicit forced pre-launch wipe decision.

The Stage 0 cleanup gate requires every temporary transitional static profile or broad profile patch route to be deleted or named as launch-blocking. Legacy Source Observation marker reads are not retained paths; they are reset/drop verification only. Normal Admin workflows must stay section-scoped and typed with `rawJsonBacked=false`; broad raw profile patching is not a launch workflow. Complete deletion of current-page code, route/API/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions follows once the rebuilt workbench is accepted.

## Test Expectations

Every compatibility surface must have focused tests for its current contract. At minimum:

- provider adapter tests cover generic integration units without provider-specific core branches
- profile store tests cover seed reconciliation, rollback, referenced-version counting, and admin-authored row preservation
- mapping contract and migration guard tests detect breaking semantic changes
- diagnostic taxonomy tests pin code severity, blocking behavior, visibility, metrics, and evidence policy
- fixture harness tests pin required flows and fixture set versions
- Admin read-model contract tests pin query keys, source inventory, stale states, job/profile schema metadata, and job consistency
- runtime job tests cover profile snapshots, duplicate active-job reuse, retry/resume, partial outcomes, and worker/API skew

This compatibility policy is not complete while any surface in this document lacks a policy owner, version marker, retention rule, deploy-skew rule, and test expectation.
