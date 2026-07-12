# Catalog Integration Observability

Catalog Integration Control Plane observability covers provider adapters, provider option queries, Catalog Integration Engine workflows, durable import/reapply/bulk review jobs, Admin readiness, and Source Observation read-model freshness.

## Ownership

- Catalog owns Source Observation semantics, provider profile readiness, diagnostic codes, operator status concepts, job outcomes, and Admin health presentation.
- Provider adapters own transport facts: provider reachability, auth/session state, pagination, retry, rate-limit, cooldown, and typed payload acquisition diagnostics.
- Platform owns OpenTelemetry export, request/worker/projection metrics, trace propagation, logs, local LGTM stack, and generic durable job runtime behavior.
- Deployables wire the Catalog `sourceObservationTelemetry` host port to platform observability. Catalog does not import the OpenTelemetry runtime directly.
- Grafana owns telemetry visualization and alert history. The canonical dashboard is `Catalog Integration Control Plane` (`chase-sets-catalog-control-plane`); Admin links may deep-link there, but Admin must stay focused on readiness, blocked actions, durable jobs, and audit evidence.

## Metrics

Catalog Integration metrics use bounded labels only. Never label by account id, user id, job id, observation id, cache key, source URL, fixture path, raw provider value, credential name, token, email, address, card data, or payload body.

| Metric | Meaning | Labels |
| --- | --- | --- |
| `chase_sets_catalog_integration_option_queries_total` | Provider option query attempts from the Catalog authoring API. | `context`, `provider`, `query_kind`, `cache_status`, `cache_source`, `result`, `degraded`, `cache_only`, `force_refresh` |
| `chase_sets_catalog_integration_jobs_total` | Catalog integration job and bulk review work-unit outcomes. | `context`, `operation`, `job_kind`, `result` |
| `chase_sets_catalog_control_plane_events_total` | Product/UX funnel events for the rebuilt Catalog Control Plane primary import-to-promotion journey and supporting workflow detours. | `context`, `event`, `provider`, `unit`, `scope`, `profile`, `job_ref`, `observation_status`, `observation_count`, `promotion_result`, `promotion_count`, `blocker_category`, `detour_target`, `detour_outcome`, `role_bucket`, `read_model_freshness` |

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

## Control Plane Funnel Events

The rebuilt Catalog Control Plane records these product/UX events through the Catalog `sourceObservationTelemetry` host port and the `chase_sets_catalog_control_plane_events_total` metric:

| Event | Emitted From | Meaning |
| --- | --- | --- |
| `catalog_control_plane.primary_workbench_viewed` | Admin integrations loader | Operator viewed the primary rebuilt workbench route. |
| `catalog_control_plane.provider_scope_selected` | Admin integrations loader | Route/read-model context includes provider, ingestion unit, and import scope. |
| `catalog_control_plane.import_started` | Admin integrations action | Operator queued or resumed a provider import. |
| `catalog_control_plane.import_completed` | Catalog integration job worker | Provider import reached a terminal successful or partial-success state. |
| `catalog_control_plane.import_failed` | Admin integrations action and Catalog integration job worker | Import command failed before enqueue or a durable import job reached a failed state. |
| `catalog_control_plane.observation_review_opened` | Admin integrations loader | Source Observation review state is available in the workbench context. |
| `catalog_control_plane.observation_evidence_opened` | Admin integrations loader mapping | A selected Source Observation context reached the review/evidence state. Drawer clicks remain local UI state; this route-context event is the server-side equivalent for funnel evidence. |
| `catalog_control_plane.promotion_preview_opened` | Admin integrations loader/action | Operator opened or generated a promotion preview context. |
| `catalog_control_plane.promotion_completed` | Bulk review worker | A promote work unit completed. |
| `catalog_control_plane.promotion_failed` | Bulk review worker | A promote work unit failed. |
| `catalog_control_plane.observation_rejected` | Admin integrations action | Operator submitted or attempted a rejection command. |
| `catalog_control_plane.observation_deferred` | Admin integrations action mapping | Operator queued a defer decision that records a reason while keeping reviewable Source Observations in review. |
| `catalog_control_plane.reapply_replay_started` | Admin integrations action | Operator queued current-active-profile reapply or original-source-profile replay. |
| `catalog_control_plane.blocker_hit` | Admin integrations loader/action | Workbench or command context reached a permission, rollout, readiness, active-job, missing-profile, missing-fixture, provider-transport, promotion-conflict, stale-context, or unknown blocker. |
| `catalog_control_plane.supporting_workflow_detour_opened` | Admin integrations loader | Operator opened a supporting workflow workspace instead of the primary import-to-promotion workspace. |
| `catalog_control_plane.returned_to_primary_path` | Admin integrations loader | Operator returned to the primary workbench from a detour context. |

The event dimensions are intentionally bounded:

- `provider`, `unit`, `scope`, and `profile` are sanitized tokens derived only from provider keys, ingestion-unit keys, safe route scope identifiers, and stable profile references.
- `job_ref` is `present` or `none`; raw job IDs stay in durable job evidence and must not become metric labels.
- `observation_status`, `observation_count`, `promotion_result`, and `promotion_count` are enum or count buckets, not raw Source Observation facts or provider values.
- `blocker_category` is one of `permission`, `rollout`, `readiness`, `active-job`, `missing-profile`, `missing-fixture`, `provider-transport`, `promotion-conflict`, `stale-context`, or `unknown`.
- `detour_target` is one rebuilt supporting workspace key, and `detour_outcome` is `opened`, `returned`, `blocked`, `abandoned`, or `not-applicable`.
- `role_bucket` is a persona bucket when available and never a user, account, email, or membership identifier.

Example Prometheus funnel query path:

```promql
sum by (event) (
  increase(chase_sets_catalog_control_plane_events_total{
    context="catalog",
    event=~"catalog_control_plane.primary_workbench_viewed|catalog_control_plane.provider_scope_selected|catalog_control_plane.import_started|catalog_control_plane.import_completed|catalog_control_plane.import_failed|catalog_control_plane.observation_review_opened|catalog_control_plane.promotion_preview_opened|catalog_control_plane.promotion_completed|catalog_control_plane.promotion_failed"
  }[24h])
)
```

Example support-detour readiness query:

```promql
sum by (detour_target, detour_outcome, blocker_category) (
  increase(chase_sets_catalog_control_plane_events_total{
    context="catalog",
    event=~"catalog_control_plane.supporting_workflow_detour_opened|catalog_control_plane.returned_to_primary_path|catalog_control_plane.blocker_hit"
  }[24h])
)
```

## Status Alignment

Admin Control Plane statuses and production observability use the same concepts:

| Admin concept | Production signal |
| --- | --- |
| `ready` | no blocking diagnostics, recent successful query/job signals, projections inside fresh SLO |
| `degraded` | stale cache used, provider retry/cooldown, partial read model, job partial failures |
| `blocked` | activation/import/promotion/reapply intentionally stopped by diagnostic or rollout control |
| `lagging` | projection/read-model lag exceeds fresh budget but has recoverable checkpoint evidence |
| `unavailable` | provider/API/read model cannot answer safely; workflow must not continue |

The canonical diagnostic vocabulary remains [Catalog Integration Diagnostic Taxonomy](./catalog-integration-diagnostic-taxonomy.md). Read-model freshness budgets remain [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md). First-slice provider transport reliability categories, blocker mapping, proof criteria, and performance budgets are documented in [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md).

## Magic Launch Monitor

Staging UAT and production launch for MTGJSON, Scryfall, and TCGplayer must monitor the same bounded signals in Admin and Grafana:

| Launch signal | Admin evidence | Telemetry or metric evidence |
| --- | --- | --- |
| Provider availability | Integration health provider readiness, credential readiness, transport readiness, and latest provider diagnostic by provider/unit. | Provider option query result labels, adapter diagnostics, request/worker metrics, and `catalog_control_plane.blocker_hit` with `blocker_category="provider-transport"` when transport blocks a workflow. |
| Option-query freshness and cache-only/stale state | Import scope option selectors show cache status, stale window, cache-only state, degraded state, and unavailable empty-cache state. | `chase_sets_catalog_integration_option_queries_total` labels `cache_status`, `cache_source`, `result`, `degraded`, `cache_only`, and `force_refresh`. |
| Job lag | Import jobs and bulk review job cards show queued/running age, progress, active-job conflicts, stale job state, and terminal status. | `chase_sets_catalog_integration_jobs_total`, worker processed counts, worker duration, and projection freshness metrics. |
| Failure rate | Failed import, reapply, promote, reject, and defer outcomes are visible in job cards and health triage. | `chase_sets_catalog_integration_jobs_total` by `job_kind` and `result`, plus control-plane events `import_failed`, `promotion_failed`, and `blocker_hit`. |
| Blocked promotions | Promotion preview shows blocked counts and blocker categories before writes. | Control-plane events with `promotion_result="blocked"` and blocker categories `promotion-conflict`, `readiness`, `rollout`, or `stale-context`. |
| Conflict counts | Conflict resolution workspace and Source Observation review show conflicting counts and evidence summaries. | Control-plane events with `promotion_result="conflicting"` and bounded promotion count buckets. |
| Duplicate-prevention blocks | Source Observation review and dry-run duplicate-prevention preview show duplicate candidate counts and blocking rule. | Bounded control-plane promotion count buckets and reviewed dry-run evidence; do not export raw duplicate evidence lists as metric labels. |
| Emergency-stop state | Integration health rollout controls summary shows `provider-api-emergency-stop` active for the intended provider scope only. | Rollout denial evidence with `metricKey="catalog.integration.rollout.provider_api_emergency_stop"` and `blocker_category="rollout"`; provider keys remain bounded labels. |

Launch monitoring is passing only when the three providers are distinguishable by bounded provider key, no signal requires raw provider payloads or credentials to diagnose, and a single-provider stop is visible without hiding the readiness of the other two providers.

## Alert Starters

Start with low-noise alerts and tune thresholds after production baselines:

- Provider option query failures: elevated `result="failure"` by provider/query kind over 15 minutes.
- Stale/cache-only option queries: elevated `degraded="true"` for required import selectors.
- Integration job failures: any sustained `operation="integration-job", result="failed"` for active provider imports or reapply.
- Bulk review failures: sustained `operation="bulk-review-work-unit", result="failed"` for promote/reject/reapply.
- Primary journey fallout: elevated `catalog_control_plane.blocker_hit` or support detours without matching `returned_to_primary_path` over 24 hours.
- Worker starvation: Catalog job runner processed count stays zero while active work units or queued jobs exist.
- Read-model lag: Source Observation, profile section, audit, or projection-lag views exceed SLO `staleAfterSeconds`.
- Adapter auth failure: credential-readiness diagnostics show missing, expired, revoked, invalid, or authentication-failed states.

Alerts should route to Catalog/Ops first. Provider policy/legal review is required before changing retention or exposing additional provider evidence.

The starter Grafana rules live in `infrastructure/observability/stack/grafana/provisioning/alerting/catalog-integration-alerts.yml`. Keep alert labels bounded and tune thresholds in Grafana/observability provisioning, not in Admin UI copy.

## Redaction Rules

- Logs and metrics may include provider key, query kind, unit key, profile version, diagnostic code, severity, status, and bounded retry/cooldown values.
- Logs and metrics must not include provider credentials, cookies, auth headers, raw payloads, payload body values, source URLs that contain secrets, customer data, seller data, price/inventory facts, job ids, observation ids, selected observation id lists, free-form operator text, or cache keys.
- Diagnostic evidence follows [Catalog Integration Data Governance](./catalog-integration-data-governance.md).

## Verification

Release verification should include:

- option-query metrics for cache hit, live success, stale fallback, cache-only, and unavailable/failure paths when practical;
- job metrics for import/reapply and bulk promote/reject/reapply terminal outcomes;
- control-plane funnel metrics for workbench view, provider/scope selection, import start/completion/failure, review, preview, promotion completion/failure, blocker, support detour, and return-to-primary events;
- platform worker/request/projection metrics still present in Grafana/Prometheus;
- runbook links available from release notes and docs map;
- redaction checks proving provider credentials and raw payload data are absent from logs and metric labels.
- provider proof evidence that links at least one degraded transport condition to the canonical workbench `providerTransport` and blocker categories from [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md).
