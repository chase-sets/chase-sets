# DigitalOcean Environment DNS

This Terraform root owns stable environment-level DNS that must survive App Platform resets.

## Staging

Staging delegates `staging.chasesets.com` from the parent `chasesets.com` zone into its own DigitalOcean DNS zone. That makes `staging.chasesets.com` a zone apex, so App Platform can manage routing and certificates with apex-compatible records while Google Workspace MX/TXT records coexist at the same owner name.

This root owns the child-zone records that are not App Platform domains:

- Google Workspace MX/SPF at `staging.chasesets.com`.
- Optional Google Workspace DKIM at `google._domainkey.staging.chasesets.com`.
- SES bounce, DKIM, and DMARC records used by staging transactional email.
- Catalog asset CDN CNAME at `assets.staging.chasesets.com`.

App Platform owns its own domain records inside the child zone, including `staging.chasesets.com`, `www.staging.chasesets.com`, `marketplace.staging.chasesets.com`, and `admin.staging.chasesets.com`.
