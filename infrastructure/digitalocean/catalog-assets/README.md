# DigitalOcean Catalog Asset Infrastructure

This Terraform root owns the stable DigitalOcean Spaces buckets, CDN endpoints, managed TLS certificates, and CDN custom domains for Catalog-owned provider imagery. DigitalOcean creates the matching DNS records when the CDN custom domains are attached.

The platform root consumes the resulting bucket/domain names. PR preview platform states must not own these shared resources because all preview apps use the same preview asset bucket and CDN domain.

## State Keys

- Preview: `catalog-assets/preview.tfstate`
- Staging: `catalog-assets/staging.tfstate`
- Production: `catalog-assets/production.tfstate`

## Apply

Run from this directory after the state bucket exists:

```bash
terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=catalog-assets/<environment>.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true

terraform apply -var=environment=<environment>
```

`DIGITALOCEAN_ACCESS_TOKEN`, `SPACES_ACCESS_ID`, and `SPACES_SECRET_KEY` must be supplied through `TF_VAR_*` variables. The Spaces key needs permission to create the three Catalog asset buckets and to read/write the Terraform state bucket.

Prefer the `Platform Catalog Assets Apply` GitHub workflow for staging and production plan/apply evidence. It initializes this root with `catalog-assets/<environment>.tfstate`, uploads a redacted plan artifact, verifies bucket-root `AccessDenied` after apply, and can verify a support-safe known CDN object path without printing object keys.
