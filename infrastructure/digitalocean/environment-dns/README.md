# DigitalOcean Environment DNS

This Terraform root owns durable environment DNS that is independent of runtime compute. Staging owns its delegated zone and stable mail, asset, and DOKS diagnostic records here. Production uses a separate state key for DOKS diagnostic records in the existing root zone.

## State

- `environment-dns/staging.tfstate` — delegated staging zone, stable staging records, and DOKS diagnostic records.
- `environment-dns/production.tfstate` — production DOKS diagnostic records only.

The sibling `platform` root owns the live apex, `www`, `admin`, and conditionally exposed `marketplace` A records. Keeping live routing there preserves the existing Terraform resource addresses and prevents a delete/create DNS transition during the retired-compute decommission.

## Apply

```bash
terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=environment-dns/staging.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true

terraform apply \
  -var=environment=staging \
  -var=digitalocean_token="$DIGITALOCEAN_ACCESS_TOKEN" \
  -var=spaces_access_id="$SPACES_ACCESS_ID" \
  -var=spaces_secret_key="$SPACES_SECRET_KEY" \
  -var=doks_ingress_target=<load-balancer-ip-address>
```

The Platform Deploy workflow runs the same root before the durable platform root. Staging reset preserves these records and queues a DOKS deployment after rebuilding the managed database.

## Staging

`staging.chasesets.com` is delegated from `chasesets.com` into its own DigitalOcean zone so apex routing can coexist with Google Workspace MX and TXT records. This root owns:

- Google Workspace MX, SPF, and optional DKIM;
- SES bounce, DKIM, and DMARC records;
- `assets.staging.chasesets.com`; and
- the `doks`, `www.doks`, `marketplace.doks`, and `admin.doks` diagnostic A records.

## Production

Production does not create, import, assign, or destroy the existing `chasesets.com` zone or its stable mail and asset records. It owns only the DOKS diagnostic A records in this root. `doks_ingress_target` is required for production planning so an unset target cannot silently remove diagnostics.

Diagnostic hostnames are retained as operator probes but are not public routing gates and are not covered by the #4055 application-delete fingerprint. Their eventual cleanup requires a separately reviewed plan.

## Validation

```bash
terraform init -backend=false
terraform fmt -check -recursive
terraform validate
```

See [DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md) for runtime diagnostics and [DigitalOcean Platform Deployment](../../../docs/runbooks/digitalocean-platform-deployment.md) for workflow and state ownership.
