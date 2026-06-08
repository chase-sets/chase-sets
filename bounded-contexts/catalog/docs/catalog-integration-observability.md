# Catalog Integration Observability

Catalog Integration Control Plane observability covers provider adapters, provider option queries, Catalog Integration Engine workflows, durable import/reapply/bulk review jobs, Admin readiness, and Source Observation read-model freshness.

## Ownership

- Catalog owns Source Observation semantics, provider profile readiness, diagnostic codes, operator status concepts, job outcomes, and Admin health presentation.
- Provider adapters own transport facts: provider reachability, auth/session state, pagination, retry, rate-limit, cooldown, and typed payload acquisition diagnostics.
- Platform owns OpenTelemetry export, request/worker/projection metrics, trace propagation, logs, local LGTM stack, and generic durable job runtime behavior.
- Deployables wire the Catalog `sourceObservationTelemetry` host port to platform observability. Catalog does not import the OpenTelemetry runtime directly.

## Metrics

Catalog Integration metrics use bounded labels only. Never label by account id, user id, job id, observation id, cache key, source URL, fixture path, raw provider value, credential name, token, email, address, card data, or payload body.

| Metric | Meaning | Labels |
| --- | --- | --- |
| `chase_sets_catalog_integration_option_queries_total` | Provider option query attempts from the Catalog authoring API. | `context`, `provider`, `query_kind`, `cache_status`, `cache_source`, `result`, `degraded`, `cache_only`, `force_refresh` |
| `chase_sets_catalog_integration_jobs_total` | Catalog integration job and bulk review work-unit outcomes. | `context`, `operation`, `job_kind`, `result` |

Related platform metrics remain authoritative for generic runtime health:

- `chase_sets_http_server_requests_total`
- `chase_sets_http_server_request_duration_ms`
- `chase_sets_worker_runs_total`
- `chase_sets_worker_run_duration_ms`
- `chase_sets_projection_runs_total`
- `chase_sets_projection_run_duration_ms`

## Logs And Traces

Catalog integration logs should use stable `type` fields and redacted evidence:

- Provider option queries: provider key, query kind, cache/degraded outcome, and diagnostic code only.
- Adapter readiness: provider key, unit key, readiness status, diagnostic code, and retry/cooldown seconds.
- Jobs: job kind, action, terminal status, counts, and diagnostic code. Do not log job payloads, raw provider responses, work-unit payloads, or source hashes when they can reveal provider payload content.
- Projection lag: projection name, read-model key, lag amount, and status.

Trace context is attached to event-store contexts where request flows already pass through platform observability. Durable worker turns should remain safe if telemetry export is unavailable.

## Status Alignment

Admin Control Plane statuses and production observability use the same concepts:

| Admin concept | Production signal |
| --- | --- |
| `ready` | no blocking diagnostics, recent successful query/job signals, projections inside fresh SLO |
| `degraded` | stale cache used, provider retry/cooldown, partial read model, job partial failures |
| `blocked` | activation/import/promotion/reapply intentionally stopped by diagnostic or rollout control |
| `lagging` | projection/read-model lag exceeds fresh budget but has recoverable checkpoint evidence |
| `unavailable` | provider/API/read model cannot answer safely; workflow must not continue |

The canonical diagnostic vocabulary remains [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md). Read-model freshness budgets remain [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md).

## Alert Starters

Start with low-noise alerts and tune thresholds after production baselines:

- Provider option query failures: elevated `result="failure"` by provider/query kind over 15 minutes.
- Stale/cache-only option queries: elevated `degraded="true"` for required import selectors.
- Integration job failures: any sustained `operation="integration-job", result="failed"` for active provider imports or reapply.
- Bulk review failures: sustained `operation="bulk-review-work-unit", result="failed"` for promote/reject/reapply.
- Worker starvation: Catalog job runner processed count stays zero while active work units or queued jobs exist.
- Read-model lag: Source Observation, profile section, audit, or projection-lag views exceed SLO `staleAfterSeconds`.
- Adapter auth failure: credential-readiness diagnostics show missing, expired, revoked, invalid, or authentication-failed states.

Alerts should route to Catalog/Ops first. Provider policy/legal review is required before changing retention or exposing additional provider evidence.

## Redaction Rules

- Logs and metrics may include provider key, query kind, unit key, profile version, diagnostic code, severity, status, and bounded retry/cooldown values.
- Logs and metrics must not include provider credentials, cookies, auth headers, raw payloads, payload body values, source URLs that contain secrets, customer data, seller data, price/inventory facts, job ids, observation ids, or cache keys.
- Diagnostic evidence follows [Catalog Integration Data Governance](./catalog-integration-data-governance.md).

## Verification

Release verification should include:

- option-query metrics for cache hit, live success, stale fallback, cache-only, and unavailable/failure paths when practical;
- job metrics for import/reapply and bulk promote/reject/reapply terminal outcomes;
- platform worker/request/projection metrics still present in Grafana/Prometheus;
- runbook links available from release notes and docs map;
- redaction checks proving provider credentials and raw payload data are absent from logs and metric labels.
