# ADR 0011: Production Observability Stack

## Status

Accepted.

## Context

ADR 0001 introduced OpenTelemetry in the platform API and a low-cost LGTM stack for local and self-hosted operations. The checked-in stack is intentionally local: short retention, local-only credentials, and Docker Compose volumes. Milestone #21 requires the same operational signals to run for production with durable storage, protected access, and scoped Prometheus-compatible query access for release automation and dashboards.

At the time of this decision, the DigitalOcean platform root deployed the customer/application runtime through App Platform. Its provider schema did not expose a durable volume contract for application services. Prometheus, Loki, Tempo, and Grafana need persistence, predictable retention, and controlled recovery, so telemetry state required an independent lifecycle.

## Decision

Run staging and production observability as a separate DigitalOcean self-hosted stack, not as extra components inside the customer-facing App Platform app. Pre-launch, staging and production share one stack to reduce recurring DigitalOcean spend while operator load and telemetry volume are low.

The production-ready topology is:

- one shared pre-launch observability host serving the long-lived environments (`staging`, `production`);
- persistent DigitalOcean Block Storage volumes for Prometheus-compatible metrics, Loki-compatible logs, Tempo-compatible traces, and Grafana state;
- `infrastructure/digitalocean/observability` as the provisioning root for hosts, volumes, DNS, firewall rules, credentials, and bootstrap;
- Docker Compose or equivalent systemd-managed containers using the checked-in `infrastructure/observability/stack` configuration as the source of truth;
- HTTPS ingress through a reverse proxy on the observability host;
- Grafana with anonymous access disabled and credentials or SSO supplied by secret management;
- OTLP ingestion behind a write credential, not a public unauthenticated endpoint;
- Prometheus-compatible query access for release automation behind a separate scoped credential.

Staging and production stay separated by bounded resource labels, especially `deployment.environment`, plus environment-specific DNS aliases (`otel.staging.chasesets.com` and `otel.chasesets.com`) pointing at the same protected collector. The OpenTelemetry Collector preserves application resource attributes and the Prometheus exporter converts them into metric labels for dashboard filtering.

The application deployables run in DOKS and export telemetry with standard OpenTelemetry environment variables. Telemetry export remains best effort: missing or unreachable observability infrastructure is an operations incident, not a customer-facing outage.

Operators have a two-plane model:

- Grafana/LGTM owns telemetry dashboards, alert state, traces, logs, metric trends, Prometheus queries for release automation and dashboards, and bounded-label exploration.
- Admin owns domain and platform operation read models, permission-aware actions, durable job/projection operation state, audit evidence, and links to the relevant Grafana dashboards and runbooks.

## Alternatives Considered

### Add Prometheus, Loki, Tempo, and Grafana as App Platform components

Rejected. The platform root already uses App Platform well for stateless application components, but the current service schema does not provide the persistent storage guarantees required for telemetry stores. Losing Grafana state or time-series data during ordinary app deploys would violate the milestone's retention and recovery requirements.

### Use a fully managed external observability provider

Deferred. A managed provider can satisfy the storage and access requirements, but the repo currently has no provider account, token, billing decision, or export contract. The self-hosted DigitalOcean path keeps the first production implementation inside the existing infrastructure provider and preserves the checked-in Grafana/LGTM assets.

### Keep production on workflow artifacts and Admin Platform Operations only

Rejected. Admin Platform Operations remains the canonical application operations surface for projection and release workflow state, but milestone #21 explicitly requires durable metrics, logs, traces, protected Grafana, and scoped Prometheus-backed query access for release automation. Recreating Grafana-style dashboards inside Admin would split alert/query ownership and weaken redaction guardrails.

## Consequences

- A new observability infrastructure root or equivalent provisioning path must own droplets, volumes, DNS, firewall rules, generated credentials, and bootstrap configuration.
- The platform deployment workflow must keep application deployable telemetry variables separate from observability host credentials.
- Release automation can query the protected Prometheus-compatible endpoint through scoped credentials rather than embedding them in the query base URL.
- Operators have two complementary surfaces: Grafana for telemetry and Admin Platform Operations for domain/platform read models and actions.
- Dashboard JSON and alert provisioning live under `infrastructure/observability`; bounded contexts own the semantics and bounded labels they emit.
- Capacity, retention, backup, and credential rotation become explicit observability operations responsibilities.
- Split the shared pre-launch stack back into isolated environment stacks when real production traffic, retention requirements, incident response, or blast-radius isolation justifies the extra Droplet and volume cost.

## Invariants

- No anonymous Grafana access in staging or production.
- No unauthenticated public OTLP write endpoint.
- No customer identifiers, account ids, user ids, checkout session ids, emails, cookies, event ids, raw URLs, provider secrets, or raw payloads in metric labels or dashboard filters.
- No production telemetry secret is committed to the repository or stored in a GitHub variable.
- Application telemetry exporter failure must not block application startup or request handling.
- Admin-rendered UI must not embed PromQL, LogQL, Grafana dashboard JSON, datasource definitions, or alert rule primitives; it may link to approved Grafana dashboards and runbooks.
