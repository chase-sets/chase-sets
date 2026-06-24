# DigitalOcean Observability Infrastructure

This Terraform root provisions the staging or production observability host described by [ADR 0011](../../../docs/adr/0011-production-observability-stack.md).

It owns:

- One monitored Ubuntu Droplet per long-lived environment.
- One attached DigitalOcean Block Storage volume for Prometheus, Loki, Tempo, Grafana, and Caddy state.
- DNS records for `grafana`, `otel`, and `prometheus` in the environment zone.
- A firewall that exposes only HTTP/HTTPS by default and SSH only when `ssh_source_addresses` is set.
- A cloud-init bootstrap that installs Docker, copies the checked-in stack config from `infrastructure/observability/stack`, and runs it behind Caddy.

Use backend keys `observability/staging.tfstate` and `observability/production.tfstate`.

The key outputs feed the platform deploy pipeline:

- `otlp_endpoint` -> `OBSERVABILITY_OTLP_ENDPOINT` GitHub environment variable when overriding the default.
- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` GitHub environment secret.
