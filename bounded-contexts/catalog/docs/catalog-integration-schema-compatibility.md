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

Legacy cleanup exceptions and launch cleanup checks are owned by [Catalog Integration Legacy Cleanup](./catalog-integration-legacy-cleanup.md) and live in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-legacy-cleanup.ts
```

The executable migration/reset policy for applying these retention decisions before launch is documented in [Catalog Integration Data Migration Reset](./catalog-integration-data-migration-reset.md) and lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-migration-reset.ts
```

## Launch Boundary

Pre-launch integration-control-plane data should be reset or rebuilt by default. Do not add compatibility adapters for old profile, payload, fixture, or job shapes unless #804 records a retained-data exception with owner, reason, removal date, removal criteria, and launch gate.

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
| Provider Integration Profile version | `catalog-provider-profile-version-v1` | provider key, profile key, profile version, compatibility mode | retain when referenced | read old, write current |
| Profile section command/projection | `catalog-profile-section-command-v1` | section key, section fingerprint, profile version | resettable pre-launch | read old, write current |
| Executable mapping contract | `catalog-executable-mapping-contract-v1` | provider key, profile key, profile version, source mapping fingerprint | retain when referenced | read old, write current |
| Catalog Integration Engine I/O | `catalog-integration-engine-io-v1` | unit key, provider key, profile version, source mapping fingerprint | resettable pre-launch | request-time current code |
| Diagnostic record | `catalog-integration-diagnostic-v1` | code, severity, blocking behavior, visibility | launched contract | read old, write current |
| Fixture contract | `catalog-fixture-contract-v1` | fixture set version, required flows, profile version | resettable pre-launch | read old, write current |
| Admin Control Plane read model | `catalog-admin-control-plane-read-model-v1` | query key, unit key, generated timestamp | launched contract | projection can lag |
| Source Observation record | `catalog-source-observation-record-v1` | provider key, source profile version, source mapping fingerprint, promotion profile version | retain when referenced | read old, write current |
| Integration durable job | `catalog-integration-durable-job-v1` | job kind, action, profile snapshot, reapply profile mode | retain when referenced | snapshot at enqueue |
| Integration work unit | `catalog-integration-work-unit-v1` | job ID, unit ID, profile snapshot, reapply profile mode | retain when referenced | snapshot at enqueue |
| Audit/evidence record | `catalog-audit-evidence-record-v1` | event name, provider key, profile version, related job, related observation | launched contract | projection can lag |

## Rules By Surface

Provider adapters may add optional capabilities or diagnostics additively. A required capability change must include fixture-backed readiness diagnostics for old adapters and must not add provider-specific branches to Catalog runtime, API routes, Admin pages, or promotion/reapply code.

Provider payload bodies, sampled payloads, and fixture payloads are not Catalog truth. Retaining payload bodies requires data-governance approval and a retained-data exception. Logs, metrics, diagnostics, and audit evidence must use redacted summaries or stable references instead of raw provider payloads.

Provider Integration Profile versions remain readable while referenced by Source Observations, jobs, rollback/deprecation history, or audit evidence. Bootstrap may preserve admin-authored profile rows, but unreferenced pre-launch rows can be reset by #804.

Executable mapping contract changes are semantic compatibility changes when they alter Source Observation external keys, source hash material, selected Options, external references, Reference Record targets, duplicate-prevention order, or promotion command plans. Activation requires migration evidence when the mapping fingerprint changes in a breaking way.

Durable integration jobs and work units snapshot profile identity at enqueue time. Worker/API deploy skew must not switch a queued job to a newer active profile. Additive payload or result fields must tolerate older queued jobs and older worker code during a rolling deployment.

Admin read models evolve additively. They must expose stale, degraded, empty, or blocked states instead of forcing UI modules to parse profile JSON, job payload JSON, or provider-specific snapshots.

Audit and diagnostic records are launched operator evidence. They must remain readable after projection rebuilds and must follow the data-governance policy for payload summaries.

## Reset And Migration Policy

Use reset/rebuild when all of these are true:

- the data was created before the control plane launched
- no launched contract or retained-data exception references it
- no active/queued durable job depends on it
- no Source Observation, promotion, audit, or rollback workflow needs it for explanation

Use compatibility adapters or migrations only when at least one of these is true:

- the data is launched or intentionally retained
- an active, deprecated, retired, or audit-referenced profile version needs to be read
- a queued/running durable job or work unit was created before deployment
- the Admin UI or an operator journey consumes the DTO as a stable contract
- a future provider addition needs an additive semantic primitive or adapter capability

The pre-launch reset mode deletes integration jobs, work units, Source Observations, learned provider option rate limits, and non-admin-authored provider profile versions, then rebuilds seeded profile versions and section projections. Active jobs block reset unless an operator records an explicit forced pre-launch wipe decision.

The #804 launch cleanup inventory additionally requires every retained transitional static profile, legacy Source Observation marker read, or broad profile patch route to be named in the retained-path table. Normal Admin workflows must stay section-scoped and typed with `rawJsonBacked=false`; broad raw profile patching remains quarantined under #789 until it is removed or permission-split.

## Test Expectations

Every compatibility surface must have focused tests for its current contract. At minimum:

- provider adapter tests cover generic integration units without provider-specific core branches
- profile store tests cover seed reconciliation, rollback, referenced-version counting, and admin-authored row preservation
- mapping contract and migration guard tests detect breaking semantic changes
- diagnostic taxonomy tests pin code severity, blocking behavior, visibility, metrics, and evidence policy
- fixture harness tests pin required flows and fixture set versions
- Admin read-model contract tests pin query keys, source inventory, stale states, job/profile schema metadata, and job consistency
- runtime job tests cover profile snapshots, duplicate active-job reuse, retry/resume, partial outcomes, and worker/API skew

Do not mark #793 complete if a surface in this document lacks a policy owner, version marker, retention rule, deploy-skew rule, and test expectation.
