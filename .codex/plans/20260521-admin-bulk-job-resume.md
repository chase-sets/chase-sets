# Admin Bulk Job Resume Plan

Date: 2026-05-21

## Context

- Original worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-admin-bulk-job-resume`
- Original branch: `codex/admin-bulk-job-resume`
- Deploy unblocker worktree: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-platform-deploy-timeout`
- Deploy unblocker branch: `codex/platform-deploy-timeout`
- Bounded context: Catalog, `features/source-observations`
- Operational surface: DigitalOcean App Platform deployment workflow and Terraform platform resource

## Repo Evidence

- `bounded-contexts/README.md` says each bounded context owns its terms, state transitions, read models, UI, and tests; Catalog owns the canonical product model.
- `bounded-contexts/catalog/README.md` makes Source Observations and their promotion/rejection into Catalog Items Catalog-owned behavior.
- `bounded-contexts/catalog/context.json` declares `source-observations` as the slice that owns provider source observations, review workflow, and promotion into Catalog Items.
- `docs/architecture/bounded-context-structure.md` says slice-local behavior should stay under the slice, with deployables acting as composition roots.
- Existing bulk work persists Catalog Source Observation jobs in `catalog_source_observation_bulk_jobs`, exposes specific job lookup/SSE, and has workers process jobs independently of client connections.
- DigitalOcean provider `digitalocean_app` uses a 30-minute create timeout by default, and the provider update path also waits with `schema.TimeoutCreate`.
- The latest staging deploys repeatedly failed in Terraform apply with `timeout waiting for app (...) deployment` after the default provider wait, while CI and local verification for the feature passed.

## Decision

Refresh recovery is server-first. The Source Observations page discovers currently active Catalog bulk review jobs from the server, then attaches to the existing persisted job status stream. Browser state is only a view of the job, not the source of truth.

Active job discovery stays inside the Source Observations slice:

- Add a runtime query for active bulk review jobs.
- Add a `GET /source-observations/bulk-jobs/active` route before parameterized job routes.
- Expose list/watch methods through the Catalog shell API client and Source Observations UI hook.
- On Source Observation list mount, pick up the oldest queued/running job, map its action and selection mode back to the existing bulk progress UI, and stream it until completion/failure.

The active list is scoped by request context when context identity is available, so a refreshed operator sees their in-flight bulk review work without turning the page into a global operations dashboard.

The deployment unblocker is operational only: raise the App Platform provider wait to 90 minutes and align staging/production workflow job and explicit deployment wait timeouts so long App Platform deployments can complete instead of failing at the provider default.

## Verification Plan

- `pnpm run deps:install` - passed for the feature worktree.
- `pnpm run sandbox:doctor` - passed for the feature worktree.
- `pnpm --filter @chase-sets/catalog test -- features/source-observations/api/route.test.ts features/source-observations/ui/source-observation-list-page.test.tsx` - passed.
- `pnpm run check:localization` - passed.
- `pnpm run typecheck` - passed.
- `pnpm run verify:static` - passed.
- `pnpm test` - passed.
- `pnpm --filter @chase-sets/app-admin-web build` - passed.
- PR #246 - merged.
- Main `Platform PR` workflow for merge commit `77ae5a65` - passed.
- Staging deploy for merge commit `77ae5a65` failed in DigitalOcean Terraform apply after timing out waiting for App Platform deployment `e1d0942a-86d5-4641-9b21-29c01c2b056b`.
- Latest main deploy after superseding commits also failed in the same DigitalOcean Terraform apply timeout.
- Deploy unblocker verification: run Terraform formatting, static verification, PR CI, merge, then verify staging and production deploys green.
