# ADR 0001: Platform API Observability

## Decision

Use OpenTelemetry in application deployables and an open-source LGTM stack for local/self-hosted observability. The application emits OTLP traces and metrics, keeps logs as JSON stdout, and propagates W3C `traceparent` / `tracestate` instead of custom correlation headers.

## Rationale

OpenTelemetry keeps the app vendor-neutral and gives us a standards-based path to managed or self-hosted backends. Grafana, Prometheus, Loki, and Tempo are low-cost, open-source defaults that can scale independently when production volume grows.

The implementation lives in `infrastructure/observability` so deployables remain thin composition roots and bounded contexts stay focused on domain behavior. Bounded contexts may define telemetry host ports and bounded metric/event contracts; deployables wire those ports to the OpenTelemetry runtime.

## Consequences

- `x-correlation-id`, `x-causation-id`, and `x-command-id` leave the public API contract.
- Stored events retain W3C trace fields: `traceId`, `spanId`, optional `parentSpanId`, and optional `traceState`.
- Metrics use bounded labels only.
- Telemetry export failure must not fail application startup.
- `infrastructure/observability` owns Grafana dashboards, alert provisioning, datasource configuration, and Prometheus query contracts for release canaries.
- Admin and other operator UIs may link to Grafana and runbooks, but must not reimplement Prometheus/Loki dashboards or own telemetry query contracts.
- Browser RUM and web deployable instrumentation are deferred until `platform-api` production readiness is stable.
