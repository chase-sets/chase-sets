# DigitalOcean Platform Deployment Runbook

The platform runtime runs on DOKS. Deployables are thin composition roots packaged as images and deployed by the platform Helm chart. Terraform owns the DOKS foundation, managed Postgres, stable DNS, catalog assets, observability, and remote state; it does not own application compute.

## State And Ownership

| Root | State key | Ownership |
| --- | --- | --- |
| `digitalocean/doks` | `doks/<environment>.tfstate` | cluster and node pools |
| `digitalocean/platform` | `landing/<environment>.tfstate` | managed Postgres, users, pools, alerts, uptime, live DOKS A records |
| `digitalocean/environment-dns` | `environment-dns/<environment>.tfstate` | durable mail, asset, and diagnostic DNS |
| `digitalocean/catalog-assets` | `catalog-assets/<environment>.tfstate` | Spaces bucket and CDN |
| `digitalocean/seed-packs` | `seed-packs/shared.tfstate` | private Observation Pack Space and bucket-scoped dev/CI keys |

Never move or remove state addresses to hide a planned destroy. Use a real backend plan and the destructive-plan approval gate.

## Preview DNS And TLS

PR previews use `pr-<number>.preview.chasesets.com`. Bootstrap shared DNS with `apply-shared-dns` and install the `preview-wildcard-tls` certificate through the DOKS add-ons workflow. Each preview deploy calls `copyPreviewWildcardTlsSecret` before it probes HTTPS. Preview cleanup is namespace and state-key scoped. Inspect the uploaded cleanup logs before removing a legacy state key by hand.

## Staging And Production Deploys

Platform Deploy renders the canonical runtime values, builds immutable images, exports environment database secrets, upgrades the `chase-sets-platform` Helm release, waits for DOKS workloads and ingress, runs projection-readiness and smoke gates, and promotes the release marker. Production remains protected by the release lock, required reviewers, deployment contract, real-state Terraform plan, and release-health gates.

Platform Deploy, Platform Staging Reset, and Platform Registry Cleanup share the `platform-registry-mutation` GitHub Actions concurrency group so deploy and registry mutations cannot race.

### Staging DNS Operations

The parent `chasesets.com` zone delegates `staging` to the child `staging.chasesets.com` zone. The child apex combines its DOKS ingress A record with Google Workspace MX/TXT records; it must never be a CNAME. `www`, `marketplace`, and `admin` are also A records targeting the DOKS load balancer. The environment DNS root owns mail, asset, and diagnostic records, while the platform root preserves the live routing resource addresses.

Retain the incident history that explains this shape: on May 17, 2026, a provider-managed alias left the staging root in `CONFIGURING`; on May 26, 2026, treating the delegated child apex as a subdomain reproduced `DomainZoneInvalid` and `DomainCNAMEMismatch`. Those retired attachment modes must not be reintroduced. When staging DNS regresses, verify delegation, exact-name MX/TXT coexistence, and equality between every live A record and the DOKS load-balancer address.

## Runtime Profiles And Databases

`landing`, `proof`, and `public` control mounted runtime slices and public exposure. Database lifecycle is a companion track to runtime profile migration, not a side effect of it. Review `provisioned_context_names`, `active_runtime_context_names`, and the exposed route set independently.

Topology/release-health evidence for profile migration must include connection-budget changes, bootstrap success, query and listener key parity, projection readiness, and projection rebuild for derived read models when a newly activated context lacks compatible read state.

## Staging Reset And Recovery Drills

Platform Staging Reset targets only managed-Postgres resources protected by its reviewed reset flow. It preserves DOKS routing and queues a fresh DOKS deploy after recreation. The database restore, Helm recovery, bootstrap-hook, and rollback drill workflows are the supported rehearsal paths; do not reproduce them with ad-hoc applies.

For a real loss of application compute or production database integrity, follow the complete [DOKS catastrophe-recovery contract](./doks-platform-operations.md#catastrophe-recovery-contract). It covers incident locking, managed-Postgres PITR, recovery from a retained `cs-prod-rp-*` fork, the source-owned Helm rollback command, mandatory revision evidence, verification, and durable reconciliation. App Platform is not a fallback.

Terraform apply failures upload sensitive errored-state evidence under the protected environment retention policy. Download it only for incident recovery and delete local copies afterward.

## Stateful Destroy Guard Override

Durable resources use `prevent_destroy`. A deliberate rebuild requires owner confirmation and a temporary source edit locally; never commit a disabled guard. Production replacement requires its own incident or migration plan.

## Retired Compute Decommission (#4055)

The removed DigitalOcean App Platform resources remain in remote state until an approved Terraform apply destroys them. The workflow-dispatch `decommission_plan_only` path performs exact live read-only plans for both `landing/staging.tfstate` and `landing/production.tfstate`; it contains no apply step.

Production deletion is allowed only when `.github/deployment/production-destructive-change-approved.md` contains the exact current plan fingerprint and address list. The format has no pending state, so the file must remain absent until the owner posts the matching approval. Never reuse the #4053 DNS-detachment fingerprint, never use `terraform state rm`, and never enqueue the decommission PR before approval.

The parked hostname is retired with the production application by the provider. Live DOKS A records retain their existing Terraform resource addresses, so the expected plan has no DNS delete/recreate transition.

## Terraform Errored State Recovery

If an apply errors after provider mutation, stop automatic retries. Compare the uploaded state artifact, remote state, DigitalOcean inventory, and the exact saved plan. Repair by import or source correction; do not force-unlock unless the lock owner is proven dead.

## DigitalOcean API Token Scope Inventory

- `DIGITALOCEAN_READONLY_TOKEN` is for inventory, drift, and diagnostics.
- `DIGITALOCEAN_REGISTRY_TOKEN` is for registry cleanup only.
- Environment `DIGITALOCEAN_ACCESS_TOKEN` performs environment-scoped Terraform and Kubernetes operations.

Spaces and Terraform-state least privilege remain separate follow-up work.

## Validation

Before publishing an infrastructure change, run Terraform format/validate for each changed root, `pnpm run check:github-actions-runtime`, focused script tests, and `pnpm run verify:static`. Apply the `full-ci` PR label when broad workflow or infrastructure coverage is required.

See [DOKS Platform Operations](./doks-platform-operations.md) for deploy, diagnostics, rollback, bootstrap-hook drill, ingress, certificate, and secret-rotation procedures.
