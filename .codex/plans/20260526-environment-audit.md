# Environment Audit Hardening

## Intent

Address the environment audit findings with infrastructure, workflow, and operational documentation changes that reduce cost and entropy while improving availability and maintainability.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-environment-audit`
- Branch: `codex/staging-alias-default-ingress`
- Base: fresh `origin/main` at `666dd876c9d4d128ece52862464f4c82834fc77d`
- Sandbox id: `7649fb27`
- Dependency setup status: installed with `pnpm run deps:install`
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Platform Operations owns operator-facing health and projection attention language.
- Shared `infrastructure/digitalocean` owns provider-specific platform, DNS, uptime, database, and App Platform composition.
- GitHub workflow files own deployment, preview cleanup, registry retention, and scheduled operational automation.
- Remote dev tooling owns disposable branch-level dev environments.

## Resolved Decisions

- Staging root DNS must support both App Platform routing and exact-name Google Workspace MX/TXT records. A May 26 deploy proved `staging.chasesets.com` cannot be made CNAME-free by setting App Platform `type = PRIMARY` with `zone = chasesets.com`; DigitalOcean still treated it as a subdomain, reported `DomainZoneInvalid`, and waited for CNAME ownership. Delegate `staging.chasesets.com` as its own DigitalOcean DNS zone, put Gmail/SES/asset DNS in that child zone, and attach the staging root to App Platform as a managed primary domain in `zone = staging.chasesets.com`.
- DigitalOcean's DNS API requires FQDN record data for NS/MX/CNAME targets to end with a trailing dot. Keep environment DNS Terraform values normalized with trailing dots even though `doctl compute domain records list` prints them without trailing dots.
- The child-zone DNS apply restored the staging asset CDN CNAME and Gmail/SES records, and live HTTPS for `assets.staging.chasesets.com` returns 200. App Platform still left child-zone aliases in `CONFIGURING` because the child zone lacked App Platform routing records. Keep mail/provider records in `environment-dns`, and let App Platform own the routing DNS records through the platform Terraform root's App Platform domain attachments.
- After the App Platform routing records were applied, `www.staging.chasesets.com`, `marketplace.staging.chasesets.com`, and `admin.staging.chasesets.com` became active, but `staging.chasesets.com` still failed TLS because DigitalOcean retained the stale root domain attachment with `DomainZoneInvalid` and `DomainCNAMEMismatch`. Removing and re-adding only that root attachment allowed App Platform to issue the certificate and `https://staging.chasesets.com/` returned 200. Deployment and staging reset workflows should run the same guarded reset before waiting on staging domains.
- The May 26 post-deploy DNS audit found duplicate identical staging apex A/AAAA records because App Platform was already ensuring apex routing records while the platform root also declared raw `digitalocean_record` resources. Remove only the raw platform apex A/AAAA resources so Terraform owns the App Platform domain attachments and App Platform owns its managed apex routing DNS. Keep the nested `www`, `marketplace`, and `admin` CNAME records in the platform root because App Platform did not recreate them after Terraform removed them and staging smoke failed with `ENOTFOUND`.
- Restoring the nested CNAME resources after the live repair requires state reconciliation because the prior Terraform apply destroyed those resources in state before the CNAMEs were recreated manually. Staging deploy and reset workflows should import matching live CNAMEs before planning so Terraform adopts the records instead of failing on duplicate record creation.
- The May 26 deploy for the first import workflow proved that matching against Terraform `live_url` is wrong for nested alias CNAME adoption: `live_url` is the staging custom root, while the live nested aliases point at the App Platform default ingress. Import reconciliation must resolve the existing app id from Terraform state, read `DefaultIngress` from DigitalOcean, strip the scheme/trailing slash, and match CNAME data against that default ingress host.
- The May 26 deploy for the default-ingress import workflow proved that Terraform import/state commands load the root module and therefore need the same `TF_VAR_*` input surface as plan/apply. Keep the reconciliation step's environment aligned with the Terraform plan/destroy steps so state adoption does not fail before planning.
- The DigitalOcean Terraform provider imports `digitalocean_record` resources with a composite `domain,record_id` value; importing with only the record id prepared the resource but left `domain` empty and failed validation.
- Uptime checks should be Terraform-managed and alert only when `alert_emails` is configured. The deployment workflows will pass `TF_VAR_alert_emails` from a GitHub Environment variable so recipient management does not require code changes.
- Uptime checks should cover customer/operator entry points and same-origin API readiness: landing, admin, canonical marketplace, and the staging root marketplace host where present.
- Catalog asset custom domains must be deployment-verified because direct Spaces origins can continue working after a CDN custom domain disappears. Staging reset should verify the CDN, DNS CNAME, and HTTPS response after recreating catalog assets; staging/production smoke should also check `CATALOG_ASSET_PUBLIC_BASE_URL`.
- Staging must not scale `platform-api` beyond one instance while realtime coordination is local. Add a Terraform validation invariant so future scaling cannot silently break SSE coordination.
- DOCR non-release image retention should be reduced from 30 days to 7 days because release tags and live App Platform tags are already protected.
- Remote-dev cloud-init placeholders should match the generator and have test coverage.
- Remote-dev documentation should stop promising a nonexistent PR preview workflow and should document manual/cron prune behavior instead.
- Production remains intentionally smaller than staging until marketplace production promotion is explicitly planned; document the difference as a launch boundary.

## Open Questions

- None. Alert recipient values can be configured outside the repository with `PLATFORM_ALERT_EMAILS`.

## Implementation Checklist

- [x] Add Terraform uptime checks and alerts for platform hosts.
- [x] Wire `TF_VAR_alert_emails` through staging, production, preview, and staging reset workflows.
- [x] Make staging root the managed App Platform primary domain so platform A/AAAA records can coexist with exact-name Gmail MX/TXT records.
- [x] Add Terraform invariants for realtime coordination and API instance count.
- [x] Tighten DOCR cleanup retention from 30 days to 7 days.
- [x] Fix remote-dev cloud-init placeholders and add generator test coverage.
- [x] Update runbooks/docs for staging root, uptime alerts, registry retention, remote-dev pruning, and production/staging shape.
- [x] Restore the missing staging Catalog asset CDN custom domain and add workflow checks for CDN/DNS/HTTPS regression coverage.
- [x] Add stable staging environment DNS Terraform for `staging.chasesets.com` child-zone delegation, Gmail MX/SPF, optional Google DKIM, SES DNS, and the staging asset CDN CNAME.
- [x] Normalize staging environment DNS NS/MX/CNAME target values with trailing dots for DigitalOcean API compatibility.
- [x] Point staging App Platform nested/root domains at the delegated child zone while keeping legacy dash-based redirect hosts in `chasesets.com`.
- [x] Attach staging child-zone App Platform domains from the platform Terraform root, leave the staging apex A/AAAA routing DNS records owned by App Platform, and keep nested App Platform CNAMEs in Terraform so App Platform routing and Gmail MX/TXT coexist without duplicate apex DNS ownership.
- [x] Import live staging nested App Platform CNAME records into Terraform state before staging deploy/reset plans when the records exist but state is missing them, matching against the App Platform default ingress host rather than the custom root URL.
- [x] Add a guarded App Platform root-domain attachment reset for the stale staging apex certificate state.
- [x] Install dependencies and run targeted tests/validation (`pnpm run test:digitalocean-app-deployment`, `terraform fmt -check -recursive infrastructure/digitalocean/platform infrastructure/digitalocean/environment-dns`, `git diff --check`, `pnpm run verify:static`, `pnpm run sandbox:doctor`).

## Documentation To Promote

- Update `docs/runbooks/digitalocean-platform-deployment.md`.
- Update `docs/architecture/environment-domain-names.md`.
- Update `docs/runbooks/email-operations.md`.
- Update `docs/runbooks/catalog-asset-storage.md`.
- Update `docs/runbooks/remote-dev.md`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
