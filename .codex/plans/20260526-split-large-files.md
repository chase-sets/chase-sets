# Split Large Files

## Intent

Reduce ambiguity in the largest source files by splitting files along existing responsibility boundaries without changing behavior, public route contracts, bounded-context ownership, or design-system component APIs.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-split-large-files`
- Branch: `codex/split-large-files`
- Base: fresh `origin/main` fetched on 2026-05-26
- Sandbox id: `39b4ebc0`
- Dependency setup status: complete; `pnpm run deps:install` and `pnpm run sandbox:doctor` succeeded
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns `item-detail` route and UI composition for browse/detail behavior.
- Catalog owns Source Observation provider import, review, and promotion behavior.
- Ordering owns order planning and committed order runtime behavior.
- `packages/design-system` owns canonical UI components and patterns.
- `infrastructure/bounded-context-runtime` and `scripts/check-structure` own technical runtime/structure enforcement and remain outside deployables.

## Resolved Decisions

- Split only where the new filename has a crisp owner: route action helpers, item-detail commerce UI, design-system marketplace UI families, design-system pattern families, ordering checkout planning, and infrastructure runtime submodules.
- Preserve existing import paths through barrel exports or an `index.ts` facade where consumers already depend on broad public surfaces.
- Split localization only by the existing first key namespace so context-owned copy remains discoverable without adding a new localization model.
- Localization checker now reads namespace files under `contracts/localization/locales/en/` in addition to the composer.
- Keep bounded-context route modules as thin composition roots over feature-owned UI and support modules.
- Do not move behavior from bounded contexts into deployables.
- Source Observation runtime remains a follow-up candidate because its clean seams are behavior-heavy provider promotion/job-store moves, not a low-risk mechanical split for this delivery.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Split Discovery item-detail route commerce components and helpers while keeping the route contract stable.
- [x] Split English localization by existing top-level translation namespace while preserving `englishTranslations`.
- [x] Split design-system marketplace component catalog into focused component-family modules with a compatibility barrel.
- [x] Split design-system app-shell patterns into focused pattern-family modules with a compatibility barrel.
- [x] Extract Ordering checkout planning helpers from the orders runtime while preserving service behavior.
- [x] Split bounded-context runtime infrastructure into focused internal modules with `index.ts` as public facade.
- [x] Evaluate Source Observation runtime after the higher-confidence splits; split only if cleanly mechanical.
- [x] Run structure, typecheck, and focused tests.
- [ ] Commit, push, and open PR.
- [ ] Verify CI, merge, deployment health, and scoped cleanup.

## Documentation To Promote

- No durable architecture docs are expected unless implementation reveals a new reusable structure rule.
- This plan is retained as the durable delivery note for the refactor.

## Verification

- `pnpm run format:check`
- `pnpm run check:structure`
- `pnpm run check:localization`
- `pnpm run check:no-any`
- `pnpm exec tsc -p tsconfig.json --noEmit --pretty false`
- `pnpm run typecheck`
- `pnpm run test:structure`
- `pnpm --filter @chase-sets/design-system run test`
- `pnpm --filter @chase-sets/discovery run test`
- `pnpm --filter @chase-sets/ordering run test`
- `pnpm exec vitest run infrastructure/bounded-context-runtime/index.test.ts contracts/localization/index.test.ts`

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
