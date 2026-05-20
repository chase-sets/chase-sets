# TCGdex Promotion Bootstrap Field Fix

## Intent
Fix TCGdex Source Observation promotion in existing environments where the Catalog integration bootstrap ran before the `card-variant` Field was added. Promotion currently fails with an internal error because the runtime requires an active `catalog_fields` row keyed `card-variant`.

## Worktree
- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-tcgdex-promotion-bootstrap-field`
- Branch: `codex/tcgdex-promotion-bootstrap-field`
- Base: `origin/main` at `e31393e2c2f1072c48de48d63645c5108e41aa6b`
- Dependencies: `pnpm run deps:install` completed using shared worktree pnpm store
- Sandbox id: `fe4314a1`

## Owning Contexts
- Catalog owns Source Observations, Fields, integration bootstrap structure, and promotion into Catalog Items.
- Deployables remain composition roots only; no deployable-owned behavior is expected.

## Repo Evidence
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` requires active Catalog Field key `card-variant` during TCGdex promotion.
- `bounded-contexts/catalog/features/fields/api/seed.ts` defines the `card-variant` Field.
- `bounded-contexts/catalog/support/authoring-support/seed.ts` skips the entire integration profile when `catalog_dimensions` already has rows, so existing durable environments never receive newly added bootstrap Fields.
- `staticTcgdexCatalogIntegrationIds` omits `card-variant`, which can hide drift in callers that rely on static integration IDs.

## Resolved Decisions
- Keep the fix Catalog-owned in Field seed/bootstrap support.
- Make Field seeding idempotent by key/id and able to create missing Fields during bootstrap replay.
- Preserve existing Catalog Item promotion behavior; this is a bootstrap reconciliation defect, not a Source Observation domain rule change.
- Do not try to mutate already-published Blueprints for optional `card-variant` membership in this hotfix; promotion can set the field value and publishing requires only required Field context.

## Implementation Checklist
- [x] Add idempotent Field bootstrap reconciliation.
- [x] Ensure `card-variant` is returned from static TCGdex integration IDs.
- [x] Add focused tests for rerunning integration bootstrap against existing structure missing `card-variant`.
- [x] Run targeted Catalog tests and repository verification.
- [ ] Commit, push, PR, CI, merge, staging and production deploy verification.

## Documentation To Promote
- Update Catalog Source Observation or provider integration docs only if the runtime/ops workflow changes. This fix should be self-documenting through bootstrap behavior and tests.

## Goal Completion Criteria
- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
