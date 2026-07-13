# DigitalOcean Platform Terraform

This Terraform root owns the durable staging and production data plane that backs the DOKS runtime:

- managed Postgres, per-context databases, users, transaction pools, and least-privilege listener grants;
- DigitalOcean uptime checks and managed-Postgres alerts;
- environment/domain outputs consumed by deployment and smoke workflows; and
- Catalog asset endpoint outputs for the sibling `catalog-assets` root.

Runtime compute, commands, environment-key contracts, replicas, probes, and ingress live with the Kubernetes slice in [infrastructure/helm/platform](../../helm/platform/README.md). DNS and mail records live in [environment-dns](../environment-dns/README.md). This root intentionally contains no application compute or deploy-target resources.

## State And Decommission Ordering

Remote state keys remain `landing/staging.tfstate` and `landing/production.tfstate`. Removing a resource from configuration does not delete its state manually: Terraform must retain the prior state so an operator-reviewed apply can plan the provider destroy.

The configuration removal in issue #4055 is intentionally destructive for the retired application resource. Do not merge or apply it until the production DNS cutover has completed, DOKS health and critical marketplace flows have been verified, and the launch owner has ended the rollback soak. Then review the real-state plans for the expected application deletes and no managed-Postgres replacement before applying.

Never run `terraform state rm` for retired application resources. That would orphan billable infrastructure instead of decommissioning it.

## Credential-Free Validation

```sh
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

Run these commands from this directory. They validate configuration only and do not inspect or mutate remote state.

## Stateful Destroy Guard Override

Durable resources use `prevent_destroy`. A deliberate database rebuild therefore requires an operator-confirmed workflow and a temporary source edit locally; never commit a disabled destroy guard. The staging reset workflow owns the reviewed recreation sequence. Production database replacement requires a separate incident or migration plan.

## Boundaries

- `infrastructure/digitalocean/doks`: cluster and node-pool foundation.
- `infrastructure/helm/platform`: DOKS workloads, runtime topology, probes, ingress, and generated values.
- `infrastructure/digitalocean/environment-dns`: stable environment DNS, mail, and DOKS live-host records.
- `infrastructure/digitalocean/catalog-assets`: Spaces bucket and CDN.
- `infrastructure/digitalocean/observability`: telemetry storage and endpoints.

The current operator workflow is documented in [DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).
