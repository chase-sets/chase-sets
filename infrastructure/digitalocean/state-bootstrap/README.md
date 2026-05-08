# DigitalOcean Terraform State Bootstrap

This Terraform root creates the DigitalOcean Spaces bucket used by the landing Terraform S3 backend. It intentionally uses local state because the remote backend bucket cannot exist before the first apply.

Run this once before initializing [landing](../landing/README.md):

```bash
terraform init
terraform apply \
  -var=digitalocean_token="$DIGITALOCEAN_ACCESS_TOKEN" \
  -var=spaces_access_id="$SPACES_ACCESS_ID" \
  -var=spaces_secret_key="$SPACES_SECRET_KEY"
```

The production deployment workflow is documented in [DigitalOcean Landing Deployment Runbook](../../../docs/runbooks/digitalocean-landing-production.md).
