# DigitalOcean Observability Infrastructure

This Terraform root provisions the consolidated pre-launch observability host described by [ADR 0011](../../../docs/adr/0011-production-observability-stack.md).

It owns:

- One monitored Ubuntu Droplet shared by staging and production.
- One attached DigitalOcean Block Storage volume for Prometheus, Loki, Tempo, Grafana, and Caddy state.
- DNS records for `grafana`, `otel`, and `prometheus` in both the staging and production zones, all pointing at the shared Droplet.
- A firewall that exposes only HTTP/HTTPS by default and SSH only when `ssh_source_addresses` is set.
- A cloud-init bootstrap that installs Docker, writes the checked-in stack config from `infrastructure/observability/stack` as compressed `write_files`, and runs it behind Caddy.
- A public, non-secret first-boot diagnostic at `/__chase-sets/observability/boot-status` on each observability hostname. It reports Docker Compose service state, Grafana health, and a redacted Grafana log tail so a Caddy 502 can be investigated without SSH or console credentials.

Use backend key `observability/shared.tfstate`.

Cost and recovery posture:

- `droplet_backups_enabled` defaults to `false` and is validated to stay false because the host is reproducible from Terraform and cloud-init.
- The attached volume is the durable observability data surface. The default posture accepts up to 24 hours of telemetry loss and requires a manual volume snapshot before destructive maintenance or risky host replacement.
- The shared pre-launch volume defaults to 50 GiB and must stay between 50 and 100 GiB unless the launch revisit criteria move the stack back to isolated environment hosts.
- Increasing `prometheus_retention` should reference the operational evidence that needs the longer recovery window.

The accepted config-drift and telemetry recovery trade-offs are documented in the [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md#observability-config-drift).

The key outputs feed the platform deploy pipeline:

- `environment_endpoints` -> staging and production endpoint inventory.
- `otlp_endpoint` -> production `OBSERVABILITY_OTLP_ENDPOINT` GitHub environment variable when overriding the default.
- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` GitHub environment secret for both staging and production while the stack is shared.
