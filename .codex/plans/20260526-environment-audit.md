# Environment Audit Hardening

## Intent

Address the environment audit findings with infrastructure, workflow, and operational documentation changes that reduce cost and entropy while improving availability and maintainability.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-environment-audit`
- Branch: `codex/environment-audit`
- Base: fresh `origin/main` at `44637eacc9d1dd66f73147f83218d6080ada3f42`
- Sandbox id: not initialized yet
- Dependency setup status: installed with `pnpm run deps:install`
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Platform Operations owns operator-facing health and projection attention language.
- Shared `infrastructure/digitalocean` owns provider-specific platform, DNS, uptime, database, and App Platform composition.
- GitHub workflow files own deployment, preview cleanup, registry retention, and scheduled operational automation.
- Remote dev tooling owns disposable branch-level dev environments.

## Resolved Decisions

- Staging root DNS must support both App Platform routing and exact-name Google Workspace MX/TXT records. Attach `staging.chasesets.com` as the staging app's managed primary domain in the `chasesets.com` zone so DigitalOcean manages A/AAAA-style platform records and Gmail MX/TXT records coexist without a CNAME.
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
- [x] Install dependencies and run targeted tests/validation.

## Documentation To Promote

- Update `docs/runbooks/digitalocean-platform-deployment.md`.
- Update `docs/architecture/environment-domain-names.md`.
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
