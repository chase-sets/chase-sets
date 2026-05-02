# Observability Runbook

Platform API observability uses OpenTelemetry for application signals and a low-cost LGTM stack for local and self-hosted operations.

## Local Startup

Start the stack:

```powershell
npm run dev:observability
```

Open Grafana:

```powershell
npm run dev:observability:open
```

Stop only observability services:

```powershell
npm run dev:observability:down
```

Grafana runs at `http://localhost:3000` with local-only default credentials `admin` / `admin`. Prometheus runs at `http://localhost:9090`, Loki at `http://localhost:3100`, Tempo at `http://localhost:3200`, and the OpenTelemetry Collector accepts OTLP at `http://localhost:4318` and `localhost:4317`.

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
- Metrics: request count/duration, event-store operation count/duration, projection/subscription run count/duration, and worker run count/duration.
- Logs: JSON stdout with `traceId` and `spanId` when an active span exists. Local dev also mirrors logs to JSONL when `LOG_FILE_PATH` is set so the Collector can tail them into Loki.

Do not log request bodies, cookies, authorization headers, provider secrets, emails, addresses, card data, or raw customer payloads.

## Dashboards And Alerts

Grafana provisions the `Platform API Overview` dashboard and starter alerts from `infrastructure/observability/stack/grafana`.

Starter alerts intentionally stay low-noise:

- elevated API 5xx rate;
- projection or subscription failures.

Add SLO burn-rate alerts only after production traffic establishes realistic latency and availability baselines.

## Production Notes

The checked-in stack uses short local retention. Production should set explicit persistent volumes, credentials, and retention:

- Prometheus/Mimir retention based on cost and operational needs;
- Loki retention for incident review windows;
- Tempo retention for trace sampling volume;
- no anonymous Grafana access;
- credentials supplied by environment or secret management.

Metric labels must stay bounded: service, environment, route template, method, status class, context, event type, projector/subscription name, and provider. Never use account, user, listing, order, payment, shipment, or session ids as metric labels.
