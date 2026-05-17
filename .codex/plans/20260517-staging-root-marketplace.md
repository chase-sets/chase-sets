# Staging Root Marketplace

## Intent

Make `https://staging.chasesets.com/` behave like the launch-facing marketplace entry point while preserving the existing staging landing host at `https://www.staging.chasesets.com/`.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-staging-root-marketplace`
- Branch: `codex/revert-staging-root-self-managed`
- Sandbox id: `03399e6c`
- Dependency setup status: `pnpm run deps:install` completed with shared pnpm store.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Infrastructure owns the external host/domain routing decision because the requested behavior changes which deployable answers a staging hostname.
- Discovery owns the marketplace browse/search page that already backs the marketplace-web root route through `deployables/marketplace/app/routes/index.tsx`.
- Marketplace owns listing and offer workflows reached after marketplace entry, but it does not own browse/search or the host-level routing.
- Public Presence owns the landing/waitlist public-web surface and should remain available at `www.staging.chasesets.com`.

## Resolved Decisions

- Do not route `staging.chasesets.com` through DigitalOcean App Platform while the root carries mail identity DNS. Managed alias, managed primary, and self-managed alias attachments were attempted, merged, and then blocked staging deployment with the domain stuck in `CONFIGURING`.
- Keep `marketplace.staging.chasesets.com` as an explicit marketplace host for existing links and operations.
- Keep `www.staging.chasesets.com` as the staging landing host so waitlist and public policy smoke checks remain stable.
- Preserve the staging legacy landing redirect smoke requirement; it is already represented by App Platform child/legacy hosts.
- Document that `https://staging.chasesets.com/` needs an external HTTPS edge or DNS-layer redirect to `https://marketplace.staging.chasesets.com/`, or a future DNS/mail-identity migration before App Platform can own the root directly.

## Implementation Checklist

- Reverted: Remove the staging root marketplace domain from DigitalOcean platform Terraform locals because staging deployment could not activate it.
- Reverted: Remove direct root marketplace smoke checks from CI because the root is not an App Platform-owned host.
- Completed: Align staging smoke with the existing legacy landing redirect requirement while waiting on all staging web domains.
- Completed: Update environment domain architecture docs and the DigitalOcean deployment runbook with the root-domain blocker and external redirect path.
- Completed: Run focused Terraform/static tests and smoke URL tests.

## Deployment Finding

- PR #164 merged on May 17, 2026 and triggered staging deployment for merge commit `400d5e61`.
- Staging deployment applied the App Platform spec, then waited on `staging.chasesets.com`.
- DigitalOcean reported `staging.chasesets.com: CONFIGURING` until the run was canceled before smoke checks.
- Live checks after cancellation still showed HTTPS failure for `https://staging.chasesets.com/` and HTTP `409`, confirming the root was not serving marketplace traffic.
- PR #173 tried a second DigitalOcean App Platform shape by making `staging.chasesets.com` the staging primary domain instead of a marketplace alias.
- Staging deployment for PR #173 merge commit `9e07089c` also timed out waiting on `staging.chasesets.com: CONFIGURING`, and DigitalOcean reported no certificate for that domain.
- PR #177 tried a third App Platform shape by attaching `staging.chasesets.com` as a self-managed alias without the Terraform `zone` field.
- Staging deployment for PR #177 merge commit `04d9f5e9` accepted the App Platform spec, but the root domain stayed `CONFIGURING`; DigitalOcean reported `DomainCNAMEMismatch` because `staging.chasesets.com` must CNAME to `chase-sets-staging-platform-98hn5.ondigitalocean.app`.
- Live DNS for `staging.chasesets.com` has A/AAAA records plus exact-name MX and TXT records for mail identity, so the required CNAME cannot be added without first moving or removing those mail records.
- Corrective PR scope: remove direct App Platform ownership of the root so staging/prod deployment can resume, and document the out-of-band redirect needed to satisfy the user-visible root behavior.

## Verification

- `pnpm run test:platform-smoke`
- `pnpm run test:digitalocean-app-deployment`
- `pnpm run verify:static`
- `terraform fmt -check -recursive infrastructure/digitalocean/platform`
- `git diff --check`

## Documentation To Promote

- `docs/architecture/environment-domain-names.md`
- `docs/runbooks/digitalocean-platform-deployment.md`

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
