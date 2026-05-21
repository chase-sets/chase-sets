# Reapply Source Integrations

## Intent

Add a Catalog-owned way to reapply provider integration mapping to already promoted Catalog Items without creating replacement Catalog Items.

The immediate driver is TCGdex mapping logic, such as the 2026-05-21 title/subtitle change. Re-import currently refreshes Source Observations only when the stored provider source hash changes. Mapping-only changes can leave the hash unchanged, so promoted Catalog Items do not receive the improved Catalog metadata even though the promotion mapper now knows how to produce it.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-reapply-source-integrations`
- Branch: `codex/reapply-source-integrations`
- Sandbox id: `e6af7a7e`
- Dependency setup status: complete via `pnpm run deps:install`.
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found.

## Owning Contexts

- Catalog owns the behavior.
- Source Observations, provider keys, normalized provider facts, review status, promotion, and Catalog Item metadata updates all live in the Catalog `source-observations` slice.
- Deployables should remain thin composition roots. API, UI, read-model, runtime, and tests should stay under `bounded-contexts/catalog/features/source-observations`.
- No downstream context should receive provider-specific reapply commands. Discovery, Inventory, Marketplace, Checkout, Ordering, Pricing, and others consume promoted Catalog facts and projections only.

## Repo Evidence

- `bounded-contexts/README.md` says Catalog is upstream for canonical item references and cross-context interaction should use stable IDs and published facts.
- `bounded-contexts/catalog/README.md` says Catalog owns provider Source Observations before review and promotion into canonical Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` defines Source Observation as a provider-sourced candidate record reviewed before it becomes Catalog truth.
- `bounded-contexts/catalog/context.json` declares `source-observations` as a Catalog slice with admin routes for Integrations and Source Observations.
- `bounded-contexts/catalog/docs/source-observation-integration.md` already states that re-importing a changed promoted Source Observation moves it to `changed`, and promoting a `changed` observation refreshes the linked Catalog Item while preserving `catalog_item_id` and Product identity.
- `bounded-contexts/catalog/features/source-observations/domain/domain.ts` treats same `sourceRecordHash` and `sourceUpdatedAt` as idempotent and returns no event, even when the integration mapping code changed.
- `bounded-contexts/catalog/features/source-observations/api/tcgdex-client.ts` builds `sourceRecordHash` from provider normalized data and sanitized payload. Title/subtitle are not stored provider facts; they are produced later by the promotion mapper.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` already has `refreshCatalogItemFromObservation`, which updates the existing Catalog Item through `ReviseCatalogItemMetadata`, field setters, tags, images, product assets, and source reference commands.
- `bounded-contexts/catalog/features/source-observations/api/runtime.test.ts` covers promoting `changed` observations into the linked Catalog Item and asserts no `CreateCatalogItem` command is issued.
- `bounded-contexts/catalog/features/source-observations/ui/integration-management-page.tsx` is the existing provider-scope surface with per-provider/language/Expansion counts, making it the natural operator entry point for scope-level reapply.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx` already supports selected and filter-scoped bulk promotion for `observed` and `changed` observations, but it intentionally excludes `promoted` observations.

## Resolved Decisions

- Ownership: Catalog Source Observations owns reapply because it owns provider review and promotion mapping into Catalog Items.
- Canonical term: use `reapply` for mapping-only replay. It is an operator action over existing promoted Source Observations, not a new provider import and not promotion of a new Source Observation.
- Scope: first implementation should support a filter/provider/language/Expansion scope, and can reuse explicit observation IDs internally where useful.
- Identity invariant: reapply must require `promoted_catalog_item_id` and must never call `CreateCatalogItem`.
- Product identity invariant: reapply may update descriptive metadata, mapped fields, tags, source references, and Catalog-owned image assets, but must not change `catalog_item_id` or derived Product identity.
- Rejected observations remain terminal and are not reapply candidates.
- Reapply should use the same Catalog Item refresh mapper as changed-observation promotion so initial promotion, changed refresh, and mapping-only reapply do not drift.
- Normal imports stay idempotent for unchanged source data; do not make every re-import mutate promoted Catalog Items automatically as a side effect.
- Reapply is an explicit Catalog admin action scoped by provider/language/Expansion filters, not an automatic mutation during TCGdex import.
- Decision accepted 2026-05-21: use the explicit action path. This preserves operator intent and confirmation around changes to already promoted Catalog Items.

## Open Questions

None blocking.

## Implementation Checklist

- [x] Install dependencies in the worktree with `pnpm run deps:install`.
- [x] Run `pnpm run sandbox:doctor` and record the sandbox id in this plan.
- [x] Add runtime support for `reapplyPromotedObservations` by selected IDs and/or filter scope.
- [x] Add read-model helpers to preview and enumerate promoted observations matching provider/language/Expansion/search filters without pagination.
- [x] Reuse `refreshCatalogItemFromObservation` for reapply so it preserves `catalog_item_id` and avoids duplicate Catalog Items.
- [x] Add API endpoints `POST /source-observations/reapply/preview`, `POST /source-observations/reapply`, and `POST /source-observations/reapply/progress`.
- [x] Add shell API client and UI hooks for reapply.
- [x] Add an operator action on the Catalog Integrations surface for promoted observations in the current scope, with confirmation that shows matched/eligible counts and scope.
- [x] Keep the primary workflow on Integrations because the operation is provider-scope oriented.
- [x] Add localization keys for reapply labels, confirmation copy, completion toasts, and failure messages.
- [x] Update `bounded-contexts/catalog/docs/source-observation-integration.md` to document mapping-only reapply separately from provider re-import and changed-observation promotion.
- [x] Add focused tests:
  - runtime reapply calls `ReviseCatalogItemMetadata` and never `CreateCatalogItem`;
  - runtime rejects promoted observations with no linked Catalog Item;
  - preview/count query only includes `promoted` observations for reapply;
  - API contract routes scope and selected IDs correctly;
  - Integrations UI shows confirmation and invokes reapply for the current provider/language/Expansion scope.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed with sandbox id `e6af7a7e`.
- `pnpm --filter @chase-sets/catalog exec vitest run features/source-observations/read-model/queries.test.ts features/source-observations/api/route.test.ts features/source-observations/api/runtime.test.ts features/source-observations/ui/integration-management-page.test.tsx` passed: 4 files, 36 tests.
- `pnpm --filter @chase-sets/catalog exec tsc --noEmit` passed.
- `pnpm run check:localization` passed for 421 source files.
- `pnpm run check:structure` passed.
- `pnpm --filter @chase-sets/catalog run test` passed: 30 files passed, 1 skipped; 200 tests passed, 4 skipped.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:test` passed across non-database workspace tests.
- `git diff --check` passed.
- Browser smoke against sandbox admin web `http://localhost:8102/catalog/integrations` passed after signing in as `demo@chasesets.test`: the page rendered `Catalog Integrations` and the `Reapply promoted` action.

## Stress Tests

- Normal flow: operator imports and promotes a TCGdex Expansion, later code changes title/subtitle mapping, operator opens Catalog Integrations, filters to TCGdex English Base Set, previews reapply for promoted observations, confirms, and linked Catalog Items receive updated metadata without new IDs.
- Partial flow: some observations in scope are still `observed` or `changed`; preview reports them as ineligible for reapply, and execution skips them instead of creating or promoting anything.
- Stale data: if an observation becomes `changed` after preview, reapply should skip it or fail that row because it now requires review through the changed-observation promotion path.
- Replay: Source Observation status does not need to change for mapping-only reapply; Catalog Item event streams record the actual metadata/field/image updates.
- Cross-context handoff: Catalog projections update; downstream contexts continue to consume Catalog facts and are not aware of TCGdex reapply commands.
- Failure/cancellation: per-observation outcomes should report failures without rolling back successful prior Catalog Item refreshes; bulk job progress should be resumable or at least observable like existing bulk review jobs.
- Low-value card economics: scope-level reapply avoids hand-editing hundreds of low-value cards after mapper improvements, protecting operational margin without weakening Catalog review boundaries.

## Documentation To Promote

- `bounded-contexts/catalog/docs/source-observation-integration.md`
- Possibly `bounded-contexts/catalog/docs/provider-integration-profiles.md` if implementation introduces provider profile mapping-version language.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
