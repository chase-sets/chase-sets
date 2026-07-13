# Environment DNS Terraform

This Terraform root owns stable environment-level DNS independently of runtime compute.

## Apply

Use the environment-specific remote state key and provide the DOKS ingress load-balancer IPv4 address:

```sh
terraform init \
  -backend-config=bucket=<state-bucket> \
  -backend-config=key=environment-dns/staging.tfstate \
  -backend-config=region=us-east-1 \
  -backend-config='endpoints={s3="https://nyc3.digitaloceanspaces.com"}' \
  -backend-config=use_path_style=true

terraform plan -var=doks_ingress_target=<load-balancer-ip>
terraform apply -var=doks_ingress_target=<load-balancer-ip>
```

The deployment workflow is the canonical apply owner. Local commands above are operator references, not routine deployment instructions.

Credential-free validation uses `terraform init -backend=false`, `terraform fmt -check -recursive`, and `terraform validate`.

## Staging Ownership

Staging delegates `staging.chasesets.com` from the parent zone into its own DigitalOcean DNS zone. This root owns:

- the delegation and child zone;
- Google Workspace MX, SPF, DKIM, and verification records;
- SES bounce, DKIM, and DMARC records;
- the Catalog asset CDN CNAME; and
- DOKS live-host A records for the apex, `www`, `marketplace`, and `admin`.

When `doks_ingress_target` is empty no runtime A records are created. Staging and production deployment configuration must provide the load-balancer target before a live deploy; the Terraform check fails closed otherwise.

DNS is durable shared infrastructure. Do not remove the zone, delegation, mail, or asset records during runtime decommissioning.
