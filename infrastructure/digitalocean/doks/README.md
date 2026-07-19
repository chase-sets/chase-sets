# DigitalOcean DOKS Foundation

This Terraform root is the first offline-validated foundation slice for the DOKS compute runtime accepted in [ADR 0018: DOKS Compute Runtime](../../../docs/adr/0018-doks-compute-runtime.md).

It owns only DOKS compute foundation:

- A staging or production DigitalOcean Kubernetes cluster.
- The primary `runtime` node pool.
- A dedicated, staging-only `runtime-xl` node pool for rolling-deploy peak capacity.
- Optional additional node pools for later measured isolation needs.
- DOKS-to-DOCR registry integration through `digitalocean_kubernetes_cluster.registry_integration`.
- Optional ownership of the account-level DigitalOcean Container Registry when `manage_container_registry=true`.

It does not own managed Postgres, context databases, PgBouncer pools, DNS, Spaces asset buckets, observability storage, Kubernetes workloads, ingress, secrets, Helm charts, or runtime manifests. Those remain in their bounded infrastructure roots.

## Defaults

Production starts with the issue-requested conservative runtime pool: 2 nodes of `s-2vcpu-4gb`.

Staging keeps the same 1-node `s-2vcpu-4gb` primary pool so Terraform does not replace the cluster, and adds a 1-node `s-4vcpu-8gb` `runtime-xl` pool for platform workloads. The dedicated pool is enabled only when `environment=staging` and `runtime_xl_node_pool_enabled=true`. It has no taints, so existing platform workloads can migrate to it without chart changes.

`kubernetes_version` is required instead of defaulted. Pick a currently supported DOKS version at live apply time and record it in the operator evidence; offline validation can use any well-formed DigitalOcean version slug.

## State Keys

- Staging: `doks/staging.tfstate`
- Production: `doks/production.tfstate`

There is no preview DOKS state in this slice.

## Offline Validation

These commands do not create a live cluster:

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
terraform plan -refresh=false -lock=false \
  -var=environment=staging \
  -var=kubernetes_version=1.33.1-do.4
```

Run the production plan with `-var=environment=production` before opening a PR. CI also validates staging and production plans without a remote backend or live refresh.

## Live Apply Notes

Initialize this root only after the state bucket has been created by [state-bootstrap](../state-bootstrap/README.md):

```bash
terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=doks/<environment>.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true
```

The account registry is shared across environments. Leave `manage_container_registry=false` unless this state is explicitly chosen to own the registry. If the registry already exists and this state should own it, import it before apply rather than recreating it.

Full #4044 acceptance still needs external live DigitalOcean evidence: cluster creation, node-pool health, DOCR integration, and an image pull from `registry.digitalocean.com/chase-sets/chase-sets-platform`. PR text for this scaffold should use `Refs #4044`, not `Closes #4044`.
