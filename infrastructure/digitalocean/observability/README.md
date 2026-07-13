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

The retained Droplet and volume are protected with `prevent_destroy`. Droplet `user_data` is ignored after first boot because cloud-init changes would otherwise force replacement; reconcile checked-in stack files in place using the [observability runbook](../../../docs/runbooks/observability.md#shared-host-reconciliation). Before the first shared-state plan, move the retained production state to `observability/shared.tfstate` and import the staging DNS aliases into that state. Never apply an empty shared state: it would attempt to create a second stack.

Grafana email delivery is enabled with `grafana_smtp_enabled=true`, `alert_emails`, and the existing secret-managed SES `SendEmail` credential. An internal-only relay translates Grafana SMTP to signed SES v2 `SendEmail` calls, restricts recipients to the configured allowlist, and publishes no host port; this avoids broadening the application IAM identity to `SendRawEmail`. The provisioned contact point routes all alert rules through the same operator recipients used for `PLATFORM_ALERT_EMAILS`-equivalent alerts. Keep credentials out of plans, shell history, and committed files.

Cost and recovery posture:

- `droplet_backups_enabled` defaults to `false` and is validated to stay false because the host is reproducible from Terraform and cloud-init.
- The attached volume is the durable observability data surface. The default posture accepts up to 24 hours of telemetry loss and requires a manual volume snapshot before destructive maintenance or risky host replacement.
- The shared pre-launch volume defaults to 100 GiB, matching the irreversibly expanded live volume, and must stay between 50 and 100 GiB unless the launch revisit criteria move the stack back to isolated environment hosts.
- The volume retains its production-era provider description because DigitalOcean treats description changes as replacement. Shared ownership is represented by tags instead, preserving the durable data surface during state adoption.
- Increasing `prometheus_retention` should reference the operational evidence that needs the longer recovery window.

The accepted config-drift and telemetry recovery trade-offs are documented in the [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md#observability-config-drift).

The key outputs feed the platform deploy pipeline:

- `environment_endpoints` -> staging and production endpoint inventory.
- `otlp_endpoint` -> production `OBSERVABILITY_OTLP_ENDPOINT` GitHub environment variable when overriding the default.
- `app_platform_otlp_headers` -> `OBSERVABILITY_OTLP_HEADERS` GitHub environment secret for both staging and production while the stack is shared.
