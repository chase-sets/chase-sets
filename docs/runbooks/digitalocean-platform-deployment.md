# DigitalOcean Platform Deployment

DOKS is the single compute deploy target for preview, staging, and production. This runbook covers the DigitalOcean resources that support it; Kubernetes rollout, diagnostics, rollback, ingress, and Secret rotation are in [DOKS Platform Operations](./doks-platform-operations.md).

## Architecture

- `infrastructure/digitalocean/doks` owns clusters and node pools.
- `infrastructure/helm/platform` owns workload topology and generated Helm values.
- `infrastructure/digitalocean/platform` owns managed Postgres, context databases and pools, uptime checks, alerts, and deployment-consumed outputs.
- `infrastructure/digitalocean/environment-dns` owns staging delegation, mail/asset DNS, and live DOKS A records.
- `infrastructure/digitalocean/catalog-assets` and `observability` remain independent durable roots.

GitHub Actions is the canonical deployment owner. Staging builds or resolves one immutable image, applies the supporting Terraform roots, rotates Kubernetes Secrets, and deploys Helm. Production promotes the same verified digest.

## Required GitHub Protection

Staging and production use protected GitHub Environments. Production approvals must remain required for database changes and runtime promotion. Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup share the `platform-registry-mutation` GitHub Actions concurrency group because DOCR garbage collection is registry-wide and read-only while it runs.

## Terraform Safety

Never delete Terraform state to retire a resource. The prior state is required for Terraform to issue the provider destroy. Review real-state plans only in the approved operator workflow.

Credential-free local checks:

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

Do not run `terraform apply`, `terraform destroy`, or a remote-state plan while preparing infrastructure decommission changes.

### Stateful Destroy Guard Override

Managed Postgres, state storage, catalog assets, observability volumes, DNS zones, and DOKS clusters use `prevent_destroy`. A deliberate rebuild requires an operator-confirmed workflow and a temporary source edit locally; never commit a disabled guard.

### Retired Compute Decommission Ordering

The issue #4055 configuration removal is safe to merge only after this order is complete:

1. Flip production DNS to the DOKS load balancer first.
2. Verify DNS convergence, TLS, Kubernetes rollout health, and critical marketplace flows.
3. Complete the launch-owner rollback soak with the retired runtime still available.
4. Merge the decommission PR.
5. Review the staging and production platform-root plans. Expected destroys must be limited to retired compute/domain resources; managed Postgres, pools, alerts, uptime checks, DOKS, mail DNS, and assets must remain.
6. Apply through the protected workflow and verify the following plan is empty.

## Preview DNS And TLS

Previews use one shared `*.preview.chasesets.com` wildcard DNS record and the `preview-wildcard-tls` Secret. Bootstrap the shared record with `apply-shared-dns`. The deployment helper uses `copyPreviewWildcardTlsSecret` for each namespace. Do not issue one certificate per PR.

Preview cleanup removes the Kubernetes namespace, per-preview compatibility state, and legacy DNS residue. Inspect the uploaded cleanup logs before removing a legacy state key by hand.

### Staging DNS Operations

The parent `chasesets.com` zone delegates `staging.chasesets.com` to its child DigitalOcean DNS zone. The child zone owns its mail, asset, and live DOKS ingress records. Diagnose staging routing from that ownership model; App Platform domain attachment is retired and must not be used as a repair path.

Historical context: on May 17, 2026, an App Platform alias remained in `CONFIGURING` and blocked the retired deployment lane. A second attachment mode expected CNAME ownership that conflicted with apex records. On May 26, 2026, the primary-domain variant again failed with `DomainZoneInvalid` and `DomainCNAMEMismatch`. These incidents are why DNS ownership now stays explicit in the environment DNS root and runtime routing points directly to DOKS.

When staging DNS regresses, verify parent delegation, child-zone live A records, the DOKS load-balancer address, cert-manager state, and ingress readiness. Do not recreate an App Platform attachment.

## DigitalOcean API Token Scope Inventory

- `DIGITALOCEAN_READONLY_TOKEN` is limited to drift and inventory workflows.
- `DIGITALOCEAN_REGISTRY_TOKEN` is limited to registry inspection and cleanup.
- `DIGITALOCEAN_ACCESS_TOKEN` remains restricted to protected workflows that mutate DigitalOcean resources.

Spaces and Terraform-state least privilege remain separate follow-up work.

## Staging Deployment

`platform-production.yml` serializes the staging path:

1. resolve and verify the immutable release image;
2. initialize and validate Terraform;
3. apply durable data/DNS configuration;
4. configure the staging Kubernetes context;
5. rotate runtime and registry-pull Secrets;
6. deploy the Helm release;
7. wait for live ingress URLs and run smoke/evidence gates.

`DOKS_INGRESS_TARGET` must contain the live load-balancer IPv4 address. There is no alternate runtime lane or serving switch.

## Production Deployment

Production promotes the staging-verified image digest. Before promotion, the workflow captures database restore-point and Helm rollback evidence, validates launch gates, applies the durable platform root, rotates Secrets, deploys the production release, and runs readiness and critical-flow smoke checks. Failed post-deploy checks use the Helm rollback target.

## Staging Reset

The confirmed reset workflow recreates staging managed Postgres and restores stable asset/DNS infrastructure. After the database root is healthy it dispatches the normal DOKS deploy workflow for the exact release commit, which rotates URLs and redeploys workloads.

## Database Operations

### Production Database Restore Points

Create a provider fork before a production database-changing deployment. Record its identifier in release evidence and let the scheduled cleanup workflow reap expired forks after the retention window.

### Staging Database Restore Drill

Use the confirmed monthly restore-drill workflow. It creates a temporary provider fork, proves the selected context data, records evidence, and deletes the fork.

### Terraform State Snapshot Recovery

Before destructive database maintenance, capture an encrypted state snapshot artifact. Recovery must restore the exact state version before any further apply.

## Smoke Coverage

The deployment path verifies landing, admin, marketplace, API readiness, provider webhook routes, native MCP/UCP routes, projection readiness, and the release-specific critical-flow gates. Support-safe artifacts must redact tokens, credentials, connection strings, and customer data.

## Registry Cleanup

Registry protection is explicit: current release tags/digests plus recent immutable SHA/tree tags. Cleanup no longer discovers protection from a compute provider. If the deploy lane is queued or active, cleanup defers.
