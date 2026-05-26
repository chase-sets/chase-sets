# Staging Catalog Projection Discrepancies

## Intent

Investigate staging discrepancies between Catalog Items, Source Observations / Integrations, and Projection Operations after Mega Evolution imports and promotion attempts.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-staging-catalog-projection-discrepancies`
- Initial branch: `codex/staging-catalog-projection-discrepancies`
- Deployment follow-up branch: `codex/staging-worker-catalog-assets`
- Sandbox id: `bfccf5f5`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` passed
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Catalog owns Source Observation promotion, Catalog Item creation, Product Asset Sets, source references, admin Catalog Item read models, and Catalog realtime topics.
- Platform Operations owns the projection operations UI language, but not Catalog projection behavior.
- Deployable worker composition roots currently determine whether Catalog background jobs receive the Catalog asset storage port.

## Findings

- Staging `me01` Mega Evolution promotion job completed with 328 requested, 0 promoted, and 328 failed. The first failure reason was `Catalog asset storage is required to promote TCGDex image assets.`
- Despite the failed promotion result, staging has 328 draft Catalog Items tagged `expansion:me01`; none have image URLs, Product Asset Sets, or source references.
- The 328 `me01` Source Observations remain `observed` and have no promoted Catalog Item link, so Catalog Integrations correctly still reports 328 needing review.
- The failed promotion wrote partial Catalog Item events before failing: 328 item streams and 3,608 item events during the `me01` promotion window, with 0 image URL events and 0 external reference events.
- Catalog realtime has 4,510 retained patches for the `catalog:admin:catalog-items` topic and 450 distinct retained summary change IDs. The admin client opens fresh SSE subscriptions without a persisted cursor, so refresh can replay retained historical invalidations even when projection source lag is zero.
- PR #290 merged the application fix at merge commit `1e4d6f1eb08ce3405b432fd33369034e53cd4d1b`; the main Platform PR workflow completed successfully.
- The first post-merge staging deployment failed during Terraform apply because the DigitalOcean `platform-worker` component exited during deploy. The worker runtime now requires Catalog asset storage in production-like environments, but the DigitalOcean worker service did not receive the `CATALOG_ASSET_*` env vars already wired for API and bootstrap components.

## Likely Causes

- Background Catalog Source Observation jobs run in worker deployables whose Catalog services are constructed without the `catalogAssetStorage` host port. API deployables wire `catalogAssetStorage`; worker deployables do not.
- Source Observation promotion is not atomic across Catalog Item commands and Source Observation promotion. It creates/revises item metadata, fields, category, and tags before attempting asset normalization/storage and before linking the source reference or marking the observation promoted.
- Catalog realtime manual reload counts unique summary invalidation IDs, not Catalog Item row IDs, and fresh page loads replay retained topic outbox from cursor `0`.

## Recommended Fix Scope

- Wire Catalog asset storage config and `catalogAssetStorage` host port into worker deployables that process Catalog Source Observation jobs.
- Make Source Observation promotion failure-safe: preflight required ports before item commands and/or move external source linking earlier enough to support idempotent retry without duplicate drafts; preferably wrap the multi-aggregate promotion workflow in an explicit recoverable process state or compensating cleanup.
- Adjust realtime subscription startup so fresh page loads start from topic head, or persist the cursor across reloads; also change Catalog reload copy/counting so it does not imply row counts when the payload is an invalidation summary.

## Implementation Checklist

- [x] Reuse fresh worktree from current `origin/main`.
- [x] Install dependencies and run sandbox doctor.
- [x] Wire Catalog asset storage into platform/admin-support workers.
- [x] Preflight Source Observation promotion before item commands and reuse partial drafts on retry.
- [x] Stop fresh realtime subscriptions from replaying retained historical invalidations.
- [x] Update focused tests.
- [x] Run affected verification.
- [x] Add DigitalOcean Catalog asset storage env wiring to the staging `platform-worker` service and production `admin-support-worker`.

## Verification

- `pnpm --filter @chase-sets/catalog run test -- features/source-observations/api/runtime.test.ts`
- `pnpm --filter @chase-sets/app-platform-worker run test -- __tests__/config.test.ts`
- `pnpm --filter @chase-sets/app-admin-support-worker run test -- __tests__/config.test.ts`
- `pnpm --filter @chase-sets/platform-runtime run test -- realtime.test.ts`
- `pnpm --filter @chase-sets/app-platform-worker run typecheck`
- `pnpm --filter @chase-sets/app-admin-support-worker run typecheck`
- `pnpm --filter @chase-sets/platform-runtime run typecheck`
- `pnpm run verify:metadata`
- `pnpm run format:check`
- `pnpm run check:no-any`
- `pnpm run check:structure`
- `pnpm run verify:typecheck`
- `pnpm run verify:test`
- `pnpm run verify:build`

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
