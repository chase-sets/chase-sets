# DigitalOcean Observability Infrastructure

This Terraform root provisions the staging or production observability host described by [ADR 0011](../../../docs/adr/0011-production-observability-stack.md).

It owns:

- One monitored Ubuntu Droplet per long-lived environment.
- One attached DigitalOcean Block Storage volume for Prometheus, Loki, Tempo, Grafana, and Caddy state.
- DNS records for `grafana`, `otel`, and `prometheus` in the environment zone.
- A firewall that exposes only HTTP/HTTPS by default and SSH only when `ssh_source_addresses` is set.
- A cloud-init bootstrap that installs Docker, writes the checked-in stack config from `infrastructure/observability/stack` as compressed `write_files`, and runs it behind Caddy.

Use backend keys `observability/staging.tfstate` and `observability/production.tfstate`.

Cost and recovery posture:

- `droplet_backups_enabled` defaults to `false` because the host is reproducible from Terraform and cloud-init. Enable it only for a named drill or incident where the extra Droplet image recovery value is worth the cost.
- The attached volume is the durable observability data surface. The default posture accepts up to 24 hours of telemetry loss and requires a manual volume snapshot before destructive maintenance or risky host replacement.
- Staging keeps Droplet backups off and the observability volume at or below 100 GiB unless an active drill or incident needs more.
- Production keeps at least a 100 GiB observability volume. Increasing `prometheus_retention` or enabling Droplet backups should reference the operational evidence that needs the longer recovery window.

The accepted config-drift and telemetry recovery trade-offs are documented in the [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md#observability-config-drift).

The key outputs feed the platform deploy pipeline:

- `otlp_endpoint` -> `OBSERVABILITY_OTLP_ENDPOINT` GitHub environment variable when overriding the default.
- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` GitHub environment secret.
