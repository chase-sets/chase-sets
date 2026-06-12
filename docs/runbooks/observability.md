# Observability Runbook

Platform API observability uses OpenTelemetry for application signals and a low-cost LGTM stack for local and self-hosted operations.

## Local Startup

Start the stack:

```powershell
pnpm run dev:observability
```

Open Grafana:

```powershell
pnpm run dev:observability:open
```

Stop only observability services:

```powershell
pnpm run dev:observability:down
```

Observability ports are assigned by the current worktree sandbox. Run
`pnpm run sandbox:doctor` to print the active Grafana, Prometheus, Loki, Tempo,
and OTLP URLs. Grafana uses local-only default credentials `admin` / `admin`.

## Application Configuration

`platform-api` reads standard OpenTelemetry-style environment variables:

- `OBSERVABILITY_ENABLED`: set to `false` to disable OTel startup.
- `OTEL_SERVICE_NAME`: defaults to `platform-api`.
- `OTEL_SERVICE_VERSION`: deployment version shown in traces and metrics.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: defaults to `http://localhost:4318`.
- `OTEL_EXPORTER_OTLP_HEADERS`: comma-separated OTLP HTTP headers for protected collectors, for example `X-Chase-Sets-Observability-Token=<token>`.
- `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`: default to full local sampling and low production ratio.
- `DEPLOYMENT_ENVIRONMENT`: `local`, `staging`, or `production`.
- `OTEL_RESOURCE_ATTRIBUTES`: comma-separated resource attributes such as `team=marketplace,region=us-central`.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `LOG_FILE_PATH`: optional JSONL mirror for local Collector file ingestion. Local dev defaults to `../../artifacts/observability/platform-api.jsonl` from the `platform-api` workspace.

The application must continue serving traffic if telemetry export is unavailable. Treat missing telemetry as an operations incident, not a customer-facing outage.

## Signals

- Traces: Hono requests, Node HTTP/fetch/pg auto-instrumentation, event-store operations, projection/subscription runs, and worker loops.
- Metrics: request count/duration, event-store operation count/duration, projection/subscription run count/duration, worker run count/duration, read-after-write projection freshness count/duration/pending lag, Catalog integration option-query/job counts, and UCP operation/security/idempotency counts.
- Logs: JSON stdout with `traceId` and `spanId` when an active span exists. The shared logger also exports sanitized structured logs to OTLP `/v1/logs` when observability is enabled. Local dev can also mirror logs to JSONL when `LOG_FILE_PATH` is set so the Collector can tail them into Loki.

Do not log request bodies, cookies, authorization headers, provider secrets, emails, addresses, card data, or raw customer payloads.

## Dashboards And Alerts

Grafana provisions the `Platform API Overview`, `Projection Freshness`, and context-specific dashboards from `infrastructure/observability/stack/grafana`.

Starter alerts intentionally stay low-noise:

- elevated API 5xx rate;
- projection or subscription failures;
- Checkout projection freshness p95/p99 SLO breaches;
- Checkout projection freshness timeout-rate breaches;
- missing read-after-write receipt or target-context regressions for critical Checkout session reads;
- target-context fallback on critical Checkout session reads when no documented rollback is active;
- pending projection freshness rows with sanitized last-error presence;
- UCP signature verification failures;
- UCP idempotency conflicts.

Add SLO burn-rate alerts only after production traffic establishes realistic latency and availability baselines.

## Staging And Production Access

Production observability topology is owned by [ADR 0011: Production Observability Stack](../adr/0011-production-observability-stack.md).
Staging rehearses the same shape before production enablement.

Use Grafana for telemetry questions: request rates, latency, projection freshness metrics, push-wake pipeline latency, traces, and log correlation. Use Admin Platform Operations for application read models and operator actions:

- Staging Grafana: `https://grafana.staging.chasesets.com`
- Staging OTLP endpoint: `https://otel.staging.chasesets.com`
- Staging Prometheus query endpoint: `https://prometheus.staging.chasesets.com`
- Staging Projection Operations: `https://admin.staging.chasesets.com/platform/projections`
- Staging Push Wakes: `https://admin.staging.chasesets.com/platform/projections?tab=wake`
- Staging Release Dashboard: `https://admin.staging.chasesets.com/platform/release-dashboard`
- Production Grafana: `https://grafana.chasesets.com`
- Production OTLP endpoint: `https://otel.chasesets.com`
- Production Prometheus query endpoint: `https://prometheus.chasesets.com`
- Production Projection Operations: `https://admin.chasesets.com/platform/projections`
- Production Push Wakes: `https://admin.chasesets.com/platform/projections?tab=wake`
- Production Release Dashboard: `https://admin.chasesets.com/platform/release-dashboard`

Grafana access requirements:

- no anonymous access in staging or production;
- no local `admin` / `admin` credentials outside local development;
- credentials or SSO come from environment/secret management;
- Prometheus-compatible query access for release automation uses a separate scoped credential;
- OTLP ingestion uses a write credential and must not be publicly writable without authentication.

The checked-in local stack uses short retention. Staging and production must set explicit persistent volumes, credentials, and retention:

- Prometheus-compatible metrics retention based on cost and operational needs;
- Loki-compatible log retention for the incident review window;
- Tempo-compatible trace retention for sampling volume;
- Grafana state persistence and backup/restore posture;
- credentials supplied by environment or secret management.

Provision staging and production with `infrastructure/digitalocean/observability` before enabling App Platform telemetry export. Use backend keys `observability/staging.tfstate` and `observability/production.tfstate`. The root outputs the exact GitHub values to set:

- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` secret in the matching GitHub environment.
- `canary_prometheus_url` -> `CANARY_PROMETHEUS_URL` variable.
- `canary_prometheus_headers` -> `CANARY_PROMETHEUS_HEADERS` secret.

The platform deploy workflow defaults `OTEL_EXPORTER_OTLP_ENDPOINT` to `https://otel.staging.chasesets.com` or `https://otel.chasesets.com`. Set `OBSERVABILITY_OTLP_ENDPOINT` only when using a different endpoint.

Missing telemetry is an operations incident. Do not page customer-facing route owners until you determine whether the application signal is actually degraded or the observability pipeline is missing data. First check whether the affected service still serves traffic, then inspect the collector/backend health, then verify the deployable's `OBSERVABILITY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT`, sampler settings, and resource attributes.

Metric labels must stay bounded: service, environment, route template, method, status class, context, event type, projector/subscription name, and provider. Never use account, user, listing, order, payment, shipment, or session ids as metric labels.

Projection freshness metrics add only bounded labels: `mount_path`, `route_path`, `target_context`, `projection`, `source_context`, `outcome`, `wait_mode`, receipt/header status, runner state, and sanitized `last_error` presence. They must not include raw URLs, path parameters, checkout session ids, account ids, user ids, guest emails, cookies, event ids, or `afterWrite` token values.

## Production Canary Queries

Production release canary telemetry uses the Prometheus-compatible query endpoint selected by ADR 0011. Configure the production GitHub Environment with:

- `CANARY_PROMETHEUS_URL`: base URL for the protected query endpoint.
- `CANARY_PROMETHEUS_QUERY_FILE`: repository-relative query file, currently `bounded-contexts/platform-operations/features/release-dashboard/read-model/canary-prometheus-queries.json`.
- `CANARY_OBSERVATION_WINDOW_SECONDS`: defaults to `300`.
- `CANARY_PROMETHEUS_HEADERS` (secret): JSON object of query headers, for example `{"X-Chase-Sets-Observability-Query":"<token>"}`.

Keep credentials out of `CANARY_PROMETHEUS_URL`; use `CANARY_PROMETHEUS_HEADERS` for bearer, basic, tenant, or gateway-specific query credentials. The first required production stack signal is `observability-transport`, backed by `up{job="otel-collector"}`. Required zero-event queries must use real liveness counters in PromQL, such as projection freshness evaluations or the authenticated Settlement provider-health canary's `provider-health-checked` operation; sparse once-per-canary counters should anchor with `max_over_time(...) * 0` rather than `rate(...) * 0` so a single scraped health sample proves liveness without turning absence into healthy zero. Empty Prometheus results are not converted to healthy zeroes. Signals that are still `needs-instrumentation` may appear as `required: false`, but they must remain visible as missing until their telemetry is live.

## Projection Freshness Queries

Use the `Projection Freshness` dashboard first during guest Buy Now or other read-after-write incidents. These starter PromQL queries match the #1075 SLO contract:

```promql
histogram_quantile(0.95, sum by (le) (rate(chase_sets_projection_freshness_wait_duration_ms_bucket{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout",outcome="fresh"}[30m])))
```

```promql
sum(rate(chase_sets_projection_freshness_evaluations_total{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout",outcome="timeout"}[30m])) / clamp_min(sum(rate(chase_sets_projection_freshness_evaluations_total{route_path="/account/checkout-sessions/:sessionId",target_context="checkout",projection="checkout.session-projection",source_context="checkout"}[30m])), 1)
```

```promql
sum by (route_path, target_context, projection, source_context, state, last_error) (rate(chase_sets_projection_freshness_pending_total[5m]))
```

The matching Loki log query is:

```logql
{service_name=~"platform-api|admin-support-api"} | json | type="read-after-write.freshness"
```

Treat a freshness alert as customer-affecting when the route is a critical handoff and the browser cannot reach either the intended page or route-owned temporary recovery. For guest Buy Now, follow [Projection Freshness Audit](./projection-freshness-audit.md) before changing route tuning.

## Catalog Integration Signals

Catalog Integration Control Plane signals add:

- `chase_sets_catalog_integration_option_queries_total`
- `chase_sets_catalog_integration_jobs_total`

These metrics use bounded provider/query/job/status labels only. Do not add job ids, Source Observation ids, cache keys, credential names, raw provider values, payload paths, source URLs, account ids, or user ids as metric labels.

Catalog-specific dashboards, alert starter conditions, redaction rules, and incident workflows live in [Catalog Integration Observability](../../bounded-contexts/catalog/docs/catalog-integration-observability.md) and [Catalog Integration Operations](./catalog-integration-operations.md).
