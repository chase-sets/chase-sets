# Catalog Integration Diagnostic Taxonomy

Catalog integration diagnostics are stable, operator-facing facts about provider integration readiness, validation, import, promotion, replay, lifecycle, and read-model health. They must be actionable enough for Admin workflows and stable enough for metrics aggregation.

The authoritative typed taxonomy lives in:

```text
bounded-contexts/catalog/features/source-observations/api/catalog-integration-diagnostic-taxonomy.ts
```

## Boundary Rules

- Catalog owns diagnostic codes, remediation language, blocking behavior, visibility, grouping keys, and evidence/redaction policy for Catalog Integration Control Plane workflows.
- Provider adapters own transport facts, credentials, provider reachability, rate limits, and raw provider response handling. When those facts affect Catalog integration readiness, adapters emit diagnostics using the Catalog taxonomy.
- Platform owns generic durable job execution, projection runtime, SSE replay, and deploy observability. Catalog owns the diagnostic presentation for Catalog jobs, read models, and projection lag.
- Diagnostics must not leak provider secrets, seller data, price signals, inventory signals, operations payloads, or raw provider blobs into events, logs, metrics, or Admin UI text.
- New diagnostic codes must be added to the typed taxonomy before they are emitted from engine, adapter, fixture, job, read-model, route, or UI-facing contracts.

## Canonical Fields

| Field | Meaning |
| --- | --- |
| `code` | Stable diagnostic identifier. Existing API route errors may keep underscore style; domain codes prefer hyphenated names. |
| `source` | Origin family: adapter, profile section, fixture, engine, job, read model, credential readiness, projection lag, or admin route. |
| `severity` | `info`, `warning`, `error`, or `blocked`. |
| `blockingBehavior` | Workflow effect, such as activation-blocking, import-blocking, promotion-blocking, retirement-blocking, read-model-blocking, advisory, or retryable. |
| `operatorVisibility` | Whether the diagnostic appears in summaries, detail rows, support-only views, or metric-only aggregation. |
| `metricKey` | Stable metric key derived from the code for rate/count aggregation. |
| `remediation` | Operator or support guidance that states the next correction. |
| `evidencePolicy` | Evidence and redaction rule for payload paths, credentials, projection metadata, or safe Catalog evidence. |
| `groupingKeys` | Fields the Admin UI and metrics can use for grouping/filtering, such as provider, profile version, section, path, unit, fixture flow, job, read model, or projection. |

## Source Families

- `adapter`: provider reachability, transport readiness, rate limits, contract drift, and fixture-backed provider health.
- `profile-section`: versioned profile identity, lifecycle, activation, deprecation, retirement, section validation, and migration evidence.
- `fixture`: fixture contract coverage, dry-run harness failures, secret evidence, status mismatches, expected diagnostics, normalized observation expectations, evidence paths, and promotion-command expectations.
- `engine`: mapping interpreter output, selected-option resolution, external reference extraction, duplicate-prevention preflight, promotion planning, import eligibility, and migration-impact signals.
- `job`: durable job lookup, checkpoint freshness, and work-unit failure summaries presented through Catalog workflows.
- `read-model`: Admin read-model partial or unavailable states.
- `credential-readiness`: missing, invalid, expired, revoked, or failed provider credentials with credential-redacted evidence only.
- `projection-lag`: stale Source Observation and audit/evidence projections.
- `admin-route`: structured API error envelopes that route clients and Admin UI modules already consume.

## Severity And Blocking

- `info`: useful readiness or health signal; never blocks a workflow.
- `warning`: operator should review or retry, but the workflow can often continue with explicit review evidence.
- `error`: the workflow cannot safely continue until the operator fixes the issue.
- `blocked`: the workflow is intentionally stopped because continuing would violate activation, import, promotion, lifecycle, read-model, evidence, or credential policy.

Blocking behavior is separate from severity. For example, a mapping migration signal can be a warning and advisory until activation requires migration evidence, while `secret-used-as-catalog-fact` is blocked because it must not enter Catalog truth, logs, UI text, or metrics dimensions.

## Admin Grouping And Filtering

Admin views should group/filter diagnostics by:

- provider key and ingestion unit
- profile version and profile section
- path/control path
- fixture flow
- job kind and job id
- read model key
- projection name
- severity and blocking behavior
- remediation and operator visibility

Summary dashboards should show counts by severity and stable code. Detail views should preserve the code, source, path, remediation, and redacted evidence policy. Support-only diagnostics may be hidden from normal operator summaries, but they must still be available for incident investigation when permissions allow.

## Metrics

Metrics aggregate by `metricKey`, severity, source, provider, unit, and code. Do not put provider payload values, credential data, seller names, price values, inventory values, or raw paths containing secrets into metric labels.

Expected metric shape:

```text
catalog.integration.diagnostic.<code>
```

Examples:

- `catalog.integration.diagnostic.activation_fixture_covered_flow`
- `catalog.integration.diagnostic.ambiguous_duplicate_candidates`
- `catalog.integration.diagnostic.source_projection_stale`

## Evidence And Redaction

Evidence policies:

- `no-evidence`: no supporting evidence should be displayed or retained.
- `safe-catalog-evidence`: may reference Catalog-owned IDs, profile version, section path, fixture flow, or normalized-safe evidence.
- `redacted-provider-evidence`: may reference provider payload paths and redacted summaries, never raw values.
- `credential-redacted`: may identify credential readiness state but never credential material.
- `projection-metadata-only`: may include projection name, lag, high-water mark, or generated timestamp, not raw event payloads.

Unsafe provider material must remain outside normalized Catalog truth, source hashes, merge identity, duplicate-prevention identity, promotion commands, logs, UI copy, and metrics dimensions.

## Implementation Rules

- Add taxonomy entries in the Source Observations API before emitting a new code.
- Prefer reusing an existing code when source, blocking behavior, visibility, remediation, and evidence policy are the same.
- Add a new code when the remediation or blocking behavior differs, even if the human message sounds similar.
- Existing route error codes with underscores are stable API contracts and should not be renamed only for taxonomy style.
- Activation readiness, import eligibility, promotion planning, rollback, retirement, and read-model availability must use `blockingBehavior` instead of inferring actionability from message text.
- Fixture and dry-run diagnostics should name the fixture flow and path, and should use redacted-provider-evidence or credential-redacted whenever they mention provider payload shape.
- Credential readiness diagnostics should use `credential-missing`, `credential-invalid`, `credential-expired`, `credential-revoked`, or `adapter-authentication-failed` and must not include secret values in message text, evidence, paths, or metric labels.

## Current Coverage

The typed taxonomy covers existing diagnostic families from:

- provider integration profile validation
- provider profile section validation and activation readiness
- fixture contract and fixture harness checks
- executable mapping contract validation
- mapping interpreter diagnostics
- Source Observation normalization and selected-option resolution
- external reference extraction
- integration engine readiness and payload planning
- duplicate-prevention and promotion preflight/planning
- mapping migration impact guardrails
- provider adapter readiness
- durable job/read-model/projection stale states
- Admin route error envelopes
