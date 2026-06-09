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
- `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`: default to full local sampling and low production ratio.
- `DEPLOYMENT_ENVIRONMENT`: `local`, `staging`, or `production`.
- `OTEL_RESOURCE_ATTRIBUTES`: comma-separated resource attributes such as `team=marketplace,region=us-central`.
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`.
- `LOG_FILE_PATH`: optional JSONL mirror for local Collector file ingestion. Local dev defaults to `../../artifacts/observability/platform-api.jsonl` from the `platform-api` workspace.

The application must continue serving traffic if telemetry export is unavailable. Treat missing telemetry as an operations incident, not a customer-facing outage.

## Signals

- Traces: Hono requests, Node HTTP/fetch/pg auto-instrumentation, event-store operations, projection/subscription runs, and worker loops.
- Metrics: request count/duration, event-store operation count/duration, projection/subscription run count/duration, worker run count/duration, read-after-write projection freshness count/duration/pending lag, Catalog integration option-query/job counts, and UCP operation/security/idempotency counts.
- Logs: JSON stdout with `traceId` and `spanId` when an active span exists. Local dev also mirrors logs to JSONL when `LOG_FILE_PATH` is set so the Collector can tail them into Loki.

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

## Production Notes

The checked-in stack uses short local retention. Production should set explicit persistent volumes, credentials, and retention:

- Prometheus/Mimir retention based on cost and operational needs;
- Loki retention for incident review windows;
- Tempo retention for trace sampling volume;
- no anonymous Grafana access;
- credentials supplied by environment or secret management.

Metric labels must stay bounded: service, environment, route template, method, status class, context, event type, projector/subscription name, and provider. Never use account, user, listing, order, payment, shipment, or session ids as metric labels.

Projection freshness metrics add only bounded labels: `mount_path`, `route_path`, `target_context`, `projection`, `source_context`, `outcome`, `wait_mode`, receipt/header status, runner state, and sanitized `last_error` presence. They must not include raw URLs, path parameters, checkout session ids, account ids, user ids, guest emails, cookies, event ids, or `afterWrite` token values.

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
