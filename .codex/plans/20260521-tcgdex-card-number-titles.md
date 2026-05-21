# TCGdex Card Number Titles

## Intent

Make TCGdex-promoted Pokemon card Catalog Items display the printed card number in the title and move supporting set/version facts into the subtitle.

Target display:

- Title: `Abra 43/102`
- Subtitle: `Base Set • 1st Edition • Common`

The displayed number should normally be `cardNumber/officialCardCount`. Sets whose printed numbering does not follow the normal expansion official count, such as promos, need a Catalog-admin configurable override.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-tcgdex-card-number-titles`
- Branch: `codex/tcgdex-card-number-titles`
- Sandbox id: `f1fe78c0`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found

## Owning Contexts

- Catalog owns the change.
- Evidence:
  - `bounded-contexts/README.md` says Catalog owns the canonical product model and provider-fed catalog facts.
  - `bounded-contexts/catalog/README.md` says Source Observations carry provider candidate fields and promotion emits Catalog Item commands.
  - `bounded-contexts/catalog/docs/source-observation-integration.md` says promotion creates draft Catalog Items and sets card identity fields, title, subtitle, tags, source references, and images.
  - `bounded-contexts/catalog/features/source-observations/api/runtime.ts` currently formats TCGdex promotion metadata in `createCatalogDraftFromObservation`, `refreshCatalogItemFromObservation`, and `formatPokemonCardSubtitle`.
  - `bounded-contexts/catalog/features/source-observations/api/tcgdex-client.ts` already normalizes `cardNumber`, `expansionCardCount`, and `expansionParallelSetCardCount`.
  - `bounded-contexts/catalog/features/reference-data/ui/reference-record-detail-page.tsx` already exposes editable Reference Record attributes in admin.

## Resolved Decisions

- Ownership: Catalog Source Observations owns formatting TCGdex-promoted Catalog Item metadata because provider observations are reviewed and promoted into Catalog truth there.
- Title: Pokemon card title from TCGdex promotion becomes `<card name> <display card number>`.
- Display card number: use `<cardNumber>/<denominator>` when a denominator is known, otherwise use `cardNumber` unchanged.
- Default denominator: use the normalized TCGdex official card count already stored as `expansionCardCount`.
- Exception mapping: use an Expansion Reference Record attribute as the admin-configurable denominator override. This keeps the mapping in Catalog Reference Data, visible and editable in the existing admin interface, rather than adding deployable-owned or provider-client configuration.
- Attribute name: `printed-card-count`. It describes the number printed on cards for display and can intentionally differ from provider total, parallel count, or operational observation count.
- Subtitle: remove card number from subtitle and join `Expansion`, non-standard variant label, and `Rarity` with ` • `.
- Standard variant subtitle behavior: omit `Standard Set` so ordinary cards read like `Base Set • Common`; keep meaningful variants such as `1st Edition`, `Standard Set Foil`, `Parallel Set - Reverse Foil`, and premium parallel labels.
- Existing promoted observations: re-promoting changed observations updates linked Catalog Item metadata through existing refresh behavior. A broader backfill can be handled by re-importing or replaying changed observations; no new cross-context event is needed for this slice.

## Open Questions

None blocking. The `printed-card-count` attribute can be changed later if product language settles on a different term, but it fits current Catalog Reference Record language and the existing admin surface.

## Implementation Checklist

- [x] Install dependencies in the worktree.
- [x] Run `pnpm run sandbox:doctor`.
- [x] Add Source Observation promotion helpers for display card number and subtitle formatting.
- [x] Query the Expansion Reference Record attributes after `ensurePokemonReferenceHierarchy` to resolve `printed-card-count`.
- [x] Update create and refresh promotion flows to use the same metadata formatter.
- [x] Extend reference type setup for Expansion to include `printed-card-count` as an allowed attribute key.
- [x] Update source observation runtime tests to cover:
  - title `Furret 136/217`
  - subtitle without the number and with bullet separators
  - non-standard variant subtitle retention
  - admin configured `printed-card-count` override
  - missing denominator fallback to bare `cardNumber`
- [x] Keep docs aligned with the new title/subtitle behavior and admin override attribute.

## Verification

- `pnpm run sandbox:doctor` passed with sandbox id `f1fe78c0`.
- `pnpm --filter @chase-sets/catalog test -- features/source-observations/api/runtime.test.ts features/source-observations/api/tcgdex-client.test.ts` passed: 13 tests.
- `pnpm run typecheck` passed.
- `pnpm --filter @chase-sets/catalog test` passed: 188 tests, 4 skipped.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` to document the title, subtitle, and `printed-card-count` exception mapping.
- Update `bounded-contexts/catalog/docs/provider-integration-profiles.md` if the profile notes need to mention the new Expansion attribute.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
