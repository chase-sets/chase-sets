# DigitalOcean Environment DNS

This Terraform root owns stable environment-level DNS that must survive App Platform resets. Staging owns its delegated zone and stable records here; production uses a separate state key that owns only DOKS shadow-validation records in the existing root zone.

## Apply

State keys:

- `environment-dns/staging.tfstate` — delegated staging zone, stable staging records, and DOKS shadow records.
- `environment-dns/production.tfstate` — production DOKS shadow records only. The `platform` root continues to own live production serving records and App Platform domain attachments.

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
  -var=spaces_secret_key="$SPACES_SECRET_KEY"
```

The `Platform Deploy` and `Platform Staging Reset` GitHub workflows run this same init/apply sequence for staging environment DNS; see [DigitalOcean Platform Deployment Runbook](../../../docs/runbooks/digitalocean-platform-deployment.md).

## Staging

Staging delegates `staging.chasesets.com` from the parent `chasesets.com` zone into its own DigitalOcean DNS zone. That makes `staging.chasesets.com` a zone apex, so App Platform can manage routing and certificates with apex-compatible records while Google Workspace MX/TXT records coexist at the same owner name.

This root owns the child-zone records that are not App Platform domains:

- Google Workspace MX/SPF at `staging.chasesets.com`.
- Optional Google Workspace DKIM at `google._domainkey.staging.chasesets.com`.
- SES bounce, DKIM, and DMARC records used by staging transactional email.
- Catalog asset CDN CNAME at `assets.staging.chasesets.com`.

The sibling `platform` root owns the live serving records and App Platform domain attachments for `staging.chasesets.com`, `www.staging.chasesets.com`, `marketplace.staging.chasesets.com`, and `admin.staging.chasesets.com`. Keeping those records with their App Platform attachment graph makes the DOKS flip collision-free.

## Production

Production reuses this root only for `doks.chasesets.com`, `www.doks.chasesets.com`, `admin.doks.chasesets.com`, and `marketplace.doks.chasesets.com` when marketplace exposure is already approved. It does not create, import, assign, or destroy the existing `chasesets.com` zone or its stable mail/assets records. The default target is empty and `production_app_serving=app-platform`, so the shipped production state is a no-op until an operator records the dedicated production load-balancer address.

## DOKS Ingress Cutover

The DOKS cutover is designed so both platforms serve during the transition and the
final record replacement is a fast, reversible DNS change — never a burn-the-bridge
move. It has independent target and serving-mode controls:

- `doks_ingress_target` — the DOKS ingress load balancer IPv4 address. Setting it
  creates the **shadow validation hosts** `doks.staging.chasesets.com`,
  `www.doks.…`, `marketplace.doks.…`, and `admin.doks.…`. These are brand-new names
  App Platform never manages, so the DOKS ingress controller and cert-manager can
  issue real certificates and pass end-to-end HTTPS probes while App Platform keeps
  serving the live hosts. No live traffic moves.
- `staging_app_serving` / `production_app_serving` — `app-platform` (default, and the rollback state) or `doks`.
  This root validates and reports the coordinated serving mode. The sibling
  `platform` root performs the live-host replacement in the same state that owns
  the App Platform CNAMEs and domain attachments.

The live DOKS records are `A` records because neither environment apex may become a CNAME. Production additionally requires `production_doks_certificate_ready=true` before the coordinated serving mode can report `doks`; set it only after the live-and-shadow DNS-01 certificate is `Ready`.

### Rehearse (both platforms serving)

```bash
terraform apply \
  -var=environment=staging \
  -var=doks_ingress_target=<load-balancer-ip-address>
```

Point HTTPS probes / `scripts/platform-ingress-wait.mjs` at the shadow hosts to prove
ingress and certificate issuance before any live host moves.

### Flip (managed cutover)

Apply this root to publish or retain the shadow records, then apply the sibling
`platform` root with the same serving mode and ingress target. Its plan destroys
each leaf CNAME before creating its replacement A record and releases the App
Platform apex attachment before creating the apex A:

```bash
terraform apply \
  -var=environment=staging \
  -var=doks_ingress_target=<load-balancer-ip-address> \
  -var=staging_app_serving=doks
```

Run the live cutover apply from `infrastructure/digitalocean/platform`; this
environment-DNS apply changes only stable and shadow records.

Production adds an enforced TTL phase before this replacement. Keep the current
serving mode, set `PRODUCTION_SERVING_DNS_PHASE=prepare-doks`, and deploy once to
lower the affected CNAME TTLs to 300 seconds or less. Only after the workflow-stored
previous TTL has expired may a second invocation set `PRODUCTION_APP_SERVING=doks`.
The production workflow refuses a direct or premature flip.

### Rollback

Flip `staging_app_serving` back to `app-platform` in both roots and apply. The
platform graph removes the DOKS records before restoring the App Platform domain
attachments and CNAMEs. App Platform is kept warm through the soak, so rollback
is a DNS change only. Keep `doks_ingress_ttl` low (300s default) until rollback
confidence and smoke evidence are recorded.

Production rollback mirrors the managed phase: retain DOKS serving while applying
`PRODUCTION_SERVING_DNS_PHASE=prepare-app-platform`, wait out the recorded live A
record TTL, then change `PRODUCTION_APP_SERVING` to `app-platform` in a second
invocation. The full production sequence and steady-TTL restoration are documented
in [DigitalOcean Platform Deployment](../../../docs/runbooks/digitalocean-platform-deployment.md#production-serving-dns-flip-and-rollback).

The full ordered flip + rollback sequence, including the App Platform apex release, is
in [DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).
