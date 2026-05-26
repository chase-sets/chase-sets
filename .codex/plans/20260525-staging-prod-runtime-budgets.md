# Staging And Production Runtime Budgets

## Intent

Staging admin pages are returning 500s because catalog API route loaders cannot acquire a Postgres client from the app-side pool before `DATABASE_POOL_CONNECTION_TIMEOUT_MS`. The current Terraform sets `DATABASE_POOL_MAX=1` for API, worker, and bootstrap components, while the platform worker runs split runner groups and catalog list endpoints run concurrent count/list queries.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-staging-prod-runtime-budgets`
- Branch: `codex/staging-runtime-budget-restore` follow-up from merged `origin/main`; original PR branch was `codex/staging-prod-runtime-budgets`.
- Sandbox id: `2bf274e4`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none.

## Owning Contexts

- Infrastructure owns DigitalOcean App Platform runtime budgets and managed Postgres pool sizing.
- Deployables own default local runtime settings, but Terraform must supply environment-specific production values.
- Bounded contexts keep their own projections and APIs; this change does not move domain behavior.

## Evidence

- Staging platform API logs show repeated `timeout exceeded when trying to connect` from `pg-pool` for `/api/catalog/dimensions`, `/api/catalog/items`, and `/api/catalog/source-observations/integration-scopes`.
- Admin web logs show `/catalog/dimensions`, `/catalog/integrations`, and `/catalog/catalog-items` returning 500 after about 10 seconds because API loaders returned 500.
- Staging App Platform currently sets `DATABASE_POOL_MAX=1`.
- Staging managed PgBouncer context pools are all size `1`.
- Platform worker currently starts 102 runners with runner group concurrency of projections `2`, jobs `1`, dispatch `1`, and scheduled `1`, which exceeds a pool of `1` before counting control-plane and health queries.
- First deployment of the component-specific runtime budgets failed because enlarged DigitalOcean managed PgBouncer pool sizes exceeded the staging database tier's available server connections. Terraform deleted several old size-1 pools before the replacement creation failed, so the follow-up must restore missing managed pools at size `1`.

## Resolved Decisions

- Use component-specific app client pools instead of one global `database_pool_max`.
- Keep staging/preview production-like App Platform component counts unchanged.
- Keep production database cluster size unchanged for this fix because production still runs the smaller landing/admin-support topology.
- Keep preview and staging managed PgBouncer context pool sizes at `1` until the database tier is scaled; managed pool size consumes server connection capacity and is not the same as app-side client concurrency.
- Set worker concurrency explicitly in Terraform so database pool sizing and runner capacity cannot drift silently.
- Update the deployment runbook to replace the obsolete statement that non-production caps every per-context client pool at one connection.
- Restore staging by recreating any missing managed context pools through Terraform at the tier-safe size.

## Implementation Checklist

- [x] Add Terraform locals for component-specific API, worker, and bootstrap database pool sizes.
- [x] Keep non-production DigitalOcean managed connection pool sizes tier-safe at `1` per context.
- [x] Wire component-specific values into platform-api, platform-worker, admin-support-api, admin-support-worker, platform-bootstrap, and admin-support-bootstrap.
- [x] Wire explicit worker runner concurrency env vars into non-production and production workers.
- [x] Update deployment docs and config tests.
- [x] Run formatting/static/config tests.
- [ ] Submit follow-up PR, verify CI, merge, and verify staging plus production deployment.
- [ ] Confirm staging admin catalog routes stop returning 500 after deployment.
- [ ] Clean worktree, remote branch, and local branch.

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
