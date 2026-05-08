# DigitalOcean Landing Infrastructure

This Terraform root manages staging and production landing infrastructure:

- DigitalOcean App Platform app with public web, admin web, admin-support API, admin-support worker, and a `PRE_DEPLOY` bootstrap job.
- DigitalOcean managed PostgreSQL with per-context databases plus a control database.
- DigitalOcean DNS domain attachment through App Platform domains.

## State Bootstrap

Create the Spaces bucket once outside this root. One common option is the AWS CLI against the Spaces endpoint:

```bash
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
aws --endpoint-url https://nyc3.digitaloceanspaces.com \
  s3 mb s3://chase-sets-terraform-state
```

Initialize with partial S3 backend config:

```bash
terraform init \
  -backend-config=bucket=chase-sets-terraform-state \
  -backend-config=key=landing/staging.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=skip_credentials_validation=true \
  -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true \
  -backend-config=use_path_style=true \
  -backend-config=use_lockfile=true
```

Use `landing/production.tfstate` for production.
