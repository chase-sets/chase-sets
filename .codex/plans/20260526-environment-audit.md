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

- Staging root DNS should move back under App Platform/DigitalOcean-managed DNS now that exact-name staging mail records are no longer present. This removes the stale manual CNAME failure mode and keeps hostname, routing, certificate, and smoke ownership together.
- Uptime checks should be Terraform-managed and alert only when `alert_emails` is configured. The deployment workflows will pass `TF_VAR_alert_emails` from a GitHub Environment variable so recipient management does not require code changes.
- Uptime checks should cover customer/operator entry points and same-origin API readiness: landing, admin, marketplace where present, and the staging root marketplace alias.
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
- [x] Fix staging root DNS ownership by letting the staging root alias use the DigitalOcean DNS zone again.
- [x] Add Terraform invariants for realtime coordination and API instance count.
- [x] Tighten DOCR cleanup retention from 30 days to 7 days.
- [x] Fix remote-dev cloud-init placeholders and add generator test coverage.
- [x] Update runbooks/docs for staging root, uptime alerts, registry retention, remote-dev pruning, and production/staging shape.
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
