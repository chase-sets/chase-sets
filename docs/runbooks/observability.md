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
- Metrics: request count/duration, event-store operation count/duration, projection/subscription run count/duration, worker run count/duration, read-after-write projection freshness count/duration/pending lag, post-write consistency outcome counts, Catalog integration option-query/job counts, and UCP operation/security/idempotency counts.
- Logs: JSON stdout with `traceId` and `spanId` when an active span exists. The shared logger also exports sanitized structured logs to OTLP `/v1/logs` when observability is enabled. Local dev can also mirror logs to JSONL when `LOG_FILE_PATH` is set so the Collector can tail them into Loki.

Do not log request bodies, cookies, authorization headers, provider secrets, emails, addresses, card data, or raw customer payloads.

## Dashboards And Alerts

Grafana provisions the `Platform API Overview`, `Projection Freshness`, and context-specific dashboards from `infrastructure/observability/stack/grafana`.
When replacing a file-provisioned Grafana alert rule UID, keep a matching `deleteRules` entry for the retired UID so Droplet rebuilds that reuse the persistent Grafana volume do not fail startup on an import conflict.

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
Staging rehearses the same secured access shape through DNS aliases on the shared pre-launch stack.
During the DOKS migration, both staging and production forward pod telemetry through the Kubernetes collector contract in `infrastructure/observability/kubernetes`. The collector attaches `deployment.environment`, `k8s.cluster.name`, namespace, deployment, pod, and node metadata, then forwards OTLP to the secured stack endpoints listed below. Keep staging and production separated by labels and dashboard variables, not by duplicate LGTM hosts.

Use Grafana for telemetry questions: request rates, latency, projection freshness metrics, push-wake pipeline latency, traces, and log correlation. Use Admin Platform Operations for application read models and operator actions:

- Staging Grafana: `https://grafana.staging.chasesets.com`
- Staging OTLP endpoint: `https://otel.staging.chasesets.com`
- Staging Prometheus query endpoint: `https://prometheus.staging.chasesets.com`
- Staging first-boot diagnostics: `https://grafana.staging.chasesets.com/__chase-sets/observability/boot-status`
- Staging Projection Wake Pipeline dashboard: `https://grafana.staging.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline`
- Staging Catalog Integration Control Plane dashboard: `https://grafana.staging.chasesets.com/d/chase-sets-catalog-control-plane/catalog-integration-control-plane`
- Staging Projection Operations: `https://admin.staging.chasesets.com/platform/projections`
- Production Grafana: `https://grafana.chasesets.com`
- Production OTLP endpoint: `https://otel.chasesets.com`
- Production Prometheus query endpoint: `https://prometheus.chasesets.com`
- Production first-boot diagnostics: `https://grafana.chasesets.com/__chase-sets/observability/boot-status`
- Production Projection Wake Pipeline dashboard: `https://grafana.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline`
- Production Catalog Integration Control Plane dashboard: `https://grafana.chasesets.com/d/chase-sets-catalog-control-plane/catalog-integration-control-plane`
- Production Projection Operations: `https://admin.chasesets.com/platform/projections`

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

## Retention And Backup Posture

The self-hosted staging and production stack is intentionally cost-aware. One shared pre-launch Droplet and one shared volume serve both long-lived environments. DigitalOcean Droplet backups protect only the reproducible host image, while DigitalOcean Block Storage volume snapshots protect the telemetry data surface. The host can be rebuilt from Terraform and cloud-init; the operational value that is not trivially recreated is the volume data for Prometheus, Loki, Tempo, Grafana, and Caddy.

Default posture:

- Shared pre-launch stack: `droplet_backups_enabled=false`, Prometheus retention kept short unless a named drill or incident needs more, observability volume between 50 and 100 GiB, and an accepted telemetry data loss window of no more than 24 hours.
- Volume protection: take a manual DigitalOcean volume snapshot before destructive maintenance, risky host replacement, or retention policy changes. Routine operation accepts short telemetry loss rather than paying for continuous host-image backups by default.
- External export: not enabled by default. Create a follow-up issue before launch if incident response needs longer metrics/log/trace retention than the single-node volume can provide at acceptable cost.

Operators can use DigitalOcean Droplet backups for host-image recovery, and DigitalOcean snapshots for Droplet or volume point-in-time copies; DigitalOcean documents these surfaces separately at [Backups](https://docs.digitalocean.com/products/backups/) and [Snapshots](https://docs.digitalocean.com/products/snapshots/). DigitalOcean also documents that Block Storage volumes can be snapshotted in [Volume Features](https://docs.digitalocean.com/products/volumes/details/features/). Treat those snapshots as account-side recovery artifacts, not downloadable telemetry exports.

The drift digest reports observability Droplet backup state and volume size. Backup-on or oversized shared observability volumes are warning findings because they are unexpected pre-launch spend posture.

Provision the shared stack with `infrastructure/digitalocean/observability` before enabling DOKS telemetry export. Use backend key `observability/shared.tfstate`. The root outputs the exact GitHub values to set:

- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` secret in both long-lived GitHub environments while the stack is shared.
- `environment_endpoints` -> staging and production Grafana, OTLP, and Prometheus endpoint inventory.

The platform deploy workflow defaults `OTEL_EXPORTER_OTLP_ENDPOINT` to `https://otel.staging.chasesets.com` or `https://otel.chasesets.com`. Set `OBSERVABILITY_OTLP_ENDPOINT` only when using a different endpoint.

Missing telemetry is an operations incident. Do not page customer-facing route owners until you determine whether the application signal is actually degraded or the observability pipeline is missing data. First check whether the affected service still serves traffic, then inspect the collector/backend health, then verify the deployable's `OBSERVABILITY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT`, sampler settings, and resource attributes.

Metric labels must stay bounded: service, environment, route template, method, status class, context, event type, projector/subscription name, and provider. Never use account, user, listing, order, payment, shipment, or session ids as metric labels.

The Kubernetes collector also drops automatic-instrumentation `db.connection_string`, `db.statement`, `db.user`, `url.full`, `url.path`, `url.query`, and `user_agent.original` attributes from traces and logs before export. Use bounded `http.route`, service, deployment, and Kubernetes metadata for correlation instead.

## Launch Revisit Criteria

Keep the shared stack until at least one of these is true:

- production traffic or incident response requires environment-isolated telemetry failure domains;
- retention needs exceed the shared single-node volume budget or require different staging and production retention windows;
- customer-facing launch support needs independent Grafana alert state, credentials, or maintenance windows per environment;
- DigitalOcean project/VPC organization work makes an ops-owned shared stack more expensive or riskier than per-environment placement.

When splitting back out, provision separate staging and production observability states, move the corresponding DNS aliases, and record plan evidence showing the duplicate shared or retired environment resources are intentionally removed.

## DOKS Consolidation Gate

Close the DOKS observability rewire only after live evidence proves:

- staging and production signals appear in one Grafana/Prometheus/Loki/Tempo stack with `deployment.environment` separation;
- Kubernetes collector metrics include bounded namespace/deployment/pod/node labels and no customer identifiers;
- alert notifications fire through the source-owned observability and managed-Postgres alert paths;
- the retired duplicate observability Droplet, volume, backups, DNS records, and token references are removed or have a named follow-up with owner-approved launch-time revisit criteria.

Use these Prometheus checks for the acceptance record; both results must be non-empty from the same Prometheus host:

```promql
count by (deployment_environment, k8s_cluster_name) (kube_node_status_condition{deployment_environment="staging",condition="Ready",status="true"})
```

```promql
count by (deployment_environment, k8s_cluster_name) (kube_node_status_condition{deployment_environment="production",condition="Ready",status="true"})
```

Also query one application metric, log stream, and trace from each environment using `deployment_environment` / `deployment.environment`. Test the provisioned email contact path once with an `environment=staging` test alert and once with `environment=production`; retain the Grafana notification result and SMTP acceptance timestamp without recording recipient addresses or credentials.

### Shared Host Reconciliation

The retained host is Droplet `577048531` with volume `chase-sets-observability-data`. Its Terraform lifecycle ignores first-boot `user_data` so a config change cannot replace the host. Reconcile `/opt/chase-sets-observability` in place over the approved SSH path, preserve the existing `.env` and Caddy tokens, validate `docker compose config`, then run `docker compose up -d --remove-orphans`. Confirm the diagnostics endpoint and Grafana health after every reconciliation.

Before planning `observability/shared.tfstate`, migrate the retained production resources and their production DNS records from the old production state, then import the three staging DNS records into the shared state. Pull and archive both source states before any state move. A shared-state plan is acceptable only when it retains Droplet `577048531`, retains its volume, changes staging aliases in place to the survivor address, and contains no replacement, detach, or deletion beyond an explicitly authorized post-acceptance cleanup.

After live telemetry and alert proof is complete, delete only the authorized staging Droplet and its attached staging volume, and verify backups are disabled on the survivor. If state access, SMTP credentials, recipient selection, or an API scope blocks proof, do not alter either stack; leave the remaining action on #4051 with the exact blocker.

Projection freshness metrics add only bounded labels: `mount_path`, `route_path`, `target_context`, `projection`, `source_context`, `outcome`, `wait_mode`, receipt/header status, runner state, and sanitized `last_error` presence. They must not include raw URLs, path parameters, checkout session ids, account ids, user ids, guest emails, cookies, event ids, or `afterWrite` token values.

Post-write consistency metrics use `chase_sets_post_write_consistency_events_total` with bounded labels only: `context`, `surface`, `strategy`, `outcome`, `route_id`, `route_template`, `correction_source`, `actor_mode`, `recovery_action`, and `freshness_outcome`. Account cart optimistic correction uses `context="checkout"`, `surface="account-cart"`, `route_id="account-cart"`, correction source `fresh-read:loader-revalidation`, and route template `/account/cart`. The add-to-cart View cart semantic handoff uses the same context/surface/route labels with `strategy="fresh-read"` and `correction_source="semantic-handoff:checkout.cart.add-line"`. Outcome values include `missing_strategy`, `optimistic_applied`, `freshness_timeout`, `rollback`, `reconciliation`, `stale_response_discard`, `handoff_satisfied`, `handoff_pending`, `handoff_expired`, `handoff_invalid`, `handoff_malformed`, and `handoff_permanent`; do not add account ids, cart ids, item ids, event ids, full URLs, raw receipts, raw handoff payloads, or customer identifiers.

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
{service_name="platform-api"} | json | type="read-after-write.freshness"
```

Treat a freshness alert as customer-affecting when the route is a critical handoff and the browser cannot reach either the intended page or route-owned temporary recovery. For guest Buy Now, follow [Projection Freshness Audit](./projection-freshness-audit.md) before changing route tuning.

## Catalog Integration Signals

Catalog Integration Control Plane signals add:

- `chase_sets_catalog_integration_option_queries_total`
- `chase_sets_catalog_integration_jobs_total`
- `chase_sets_catalog_control_plane_events_total`

These metrics use bounded provider/query/job/status labels only. Do not add job ids, Source Observation ids, cache keys, credential names, raw provider values, payload paths, source URLs, account ids, or user ids as metric labels.

Catalog-specific dashboards, alert starter conditions, redaction rules, and incident workflows live in the Grafana `Catalog Integration Control Plane` dashboard, [Catalog Integration Observability](../../bounded-contexts/catalog/docs/catalog-integration-observability.md), and [Catalog Integration Operations](./catalog-integration-operations.md).

## Settlement Wallet Adjustment Signals

The Wallet Adjustment lifecycle (ADR 0020; [Money Operations](./money-operations.md#wallet-adjustment-operations)) reuses the existing `chase_sets_settlement_operations_total` counter and its structured `settlement.operation` log line -- the same signal payouts and payout readiness already emit through `SettlementOperationsRecorder` -- rather than introducing a second metric family. Every lifecycle transition, retry, conflict, halt, and limit rejection records one `kind`:

- `wallet-adjustment-requested` / `wallet-adjustment-approved` / `wallet-adjustment-rejected` / `wallet-adjustment-posted` / `wallet-adjustment-reversed`: one genuinely new lifecycle decision each.
- `wallet-adjustment-idempotent-retry`: a replay of an already-recorded request, approval, posting, or reversal -- distinguishes safe no-op retries from new decisions in the same counter.
- `wallet-adjustment-concurrency-conflict`: the aggregate command handler caught a `concurrency_conflict` and is retrying.
- `wallet-adjustment-negative-balance-effect`: a newly-approved adjustment creates or increases a Negative Balance.
- `wallet-adjustment-halted`: the `settlement.wallet-adjustment-limits` kill switch (`haltNewActions`) blocked a new request or approval decision.
- `wallet-adjustment-limit-exceeded`: a proposed adjustment would exceed a per-adjustment, per-account-window, or per-operator-window ceiling from the same policy.

Every event also carries `safeCategory` (bounded: a closed reason code, a closed limit-violation code, or a gated action name -- never an id or free text) for log-level filtering; only `kind`, `providerName`, `setupSurface`, `safeCategory`, and `readinessStatus` become Prometheus metric labels (see `deployables/platform-api/src/main.ts`'s `settlementOperationsRecorder`), so cardinality stays bounded the same way every other settlement operation signal already does.

Auth failures (401) and step-up failures (401, `step_up_required`) at the Wallet Adjustment API boundary are not double-recorded through this counter -- they are already covered by the generic `chase_sets_http_server_requests_total` / `chase_sets_http_server_request_duration_ms` request metrics and `http.request.completed` structured logs that `createHonoObservabilityMiddleware` emits for every route, keyed by `route` and `status_class`. Alert on elevated `status_class="4xx"` for the `/api/settlement/wallet-adjustments*` route templates rather than adding a parallel bespoke signal.

Reconciliation findings (`GET /api/settlement/wallet-adjustments/reconciliation`) are not separately metriced per-finding today; the report itself is the observability surface -- poll it on a schedule and alert on any `critical`-severity finding or a nonzero finding count sustained across two consecutive polls. The finding taxonomy, severities, and remediations are documented in [Money Operations](./money-operations.md#reconciliation).

Starter alert additions for this surface: a sustained `wallet-adjustment-halted` rate (the kill switch is engaged -- confirm this was intentional), any `wallet-adjustment-concurrency-conflict` rate spike (contention on a hot adjustment stream), and any nonzero `posted-without-ledger-entry` or `duplicate-ledger-linkage` reconciliation finding (both `critical`).
