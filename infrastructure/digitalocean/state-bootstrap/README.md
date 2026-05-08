# DigitalOcean Terraform State Bootstrap

This root creates the DigitalOcean Spaces bucket used by the landing Terraform S3 backend.

It intentionally uses Terraform's local backend because the remote backend bucket cannot exist until this root has run once.

```bash
terraform init
terraform apply \
  -var=digitalocean_token="$DIGITALOCEAN_ACCESS_TOKEN" \
  -var=spaces_access_id="$SPACES_ACCESS_ID" \
  -var=spaces_secret_key="$SPACES_SECRET_KEY"
```

After this succeeds, initialize `infrastructure/digitalocean/landing` with the S3 backend settings documented there.
