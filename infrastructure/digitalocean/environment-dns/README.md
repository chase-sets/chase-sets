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

## DOKS Ingress Cutover

The DOKS cutover is designed so both platforms serve during the transition and the
flip is an instant, reversible DNS change — never a burn-the-bridge move. It has two
independent controls:

- `doks_ingress_target` — the DOKS ingress load balancer IPv4 address. Setting it
  creates the **shadow validation hosts** `doks.staging.chasesets.com`,
  `www.doks.…`, `marketplace.doks.…`, and `admin.doks.…`. These are brand-new names
  App Platform never manages, so the DOKS ingress controller and cert-manager can
  issue real certificates and pass end-to-end HTTPS probes while App Platform keeps
  serving the live hosts. No live traffic moves.
- `staging_app_serving` — `app-platform` (default, and the rollback state) or `doks`.
  Flipping to `doks` creates the **live-host cutover records**: `A` records for the
  staging apex plus `www`, `marketplace`, and `admin` pointing at the load balancer.

The records are `A` records because the staging environment root also receives
mail/TXT records and must not become a CNAME.

### Rehearse (both platforms serving)

```bash
terraform apply \
  -var=environment=staging \
  -var=doks_ingress_target=<load-balancer-ip-address>
```

Point HTTPS probes / `scripts/platform-ingress-wait.mjs` at the shadow hosts to prove
ingress and certificate issuance before any live host moves.

### Flip (instant cutover)

Release the matching App Platform records first so there is no CNAME/A collision:
set `staging_app_serving=doks` in `infrastructure/digitalocean/platform` (which drops
the `www`/`marketplace`/`admin` `staging_app_alias` CNAMEs) and release the App
Platform apex domain. Then:

```bash
terraform apply \
  -var=environment=staging \
  -var=doks_ingress_target=<load-balancer-ip-address> \
  -var=staging_app_serving=doks
```

### Rollback

Flip `staging_app_serving` back to `app-platform` in this root and the platform root.
The live-host records are removed and the App Platform records return. App Platform is
kept warm through the soak, so rollback is a DNS change only. Keep `doks_ingress_ttl`
low (300s default) until rollback confidence and smoke evidence are recorded.

The full ordered flip + rollback sequence, including the App Platform apex release, is
in [DOKS Platform Operations](../../../docs/runbooks/doks-platform-operations.md).
