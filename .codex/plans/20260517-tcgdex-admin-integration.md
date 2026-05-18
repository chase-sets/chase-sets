# TCGdex Admin Integration

## Intent

Bring the completed Catalog-owned TCGdex Source Observation and Pokemon reference functionality into the admin panel so operators can import and filter by natural Catalog/Pokemon language instead of only typing raw language codes and TCGdex expansion IDs.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-tcgdex-admin-integration`
- Branch: `codex/tcgdex-admin-integration`
- Sandbox id: `aaaefc76`
- Dependency setup status: `pnpm run deps:install` completed successfully on 2026-05-17.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully on 2026-05-17.
- Setup blockers: none. Existing warning: cyclic workspace dependencies among checkout, ordering, marketplace-seed-testing, and discovery.

## Owning Contexts

- Catalog owns the change because Source Observations, TCGdex import, Reference Types, Reference Records, promotion, and admin routes are Catalog-owned behavior.
- Discovery, Marketplace, Inventory, and Pricing remain downstream. No downstream product truth or search behavior changes are needed.
- `admin-web` stays a thin composition root through Catalog route contributions.

## Resolved Decisions

- Keep the API import contract as `{ languageCode, setId }` because TCGdex still calls the external provider resource a set ID, while Catalog-facing UI copy should say Expansion.
- Load active Catalog `Expansion` Reference Records for the Source Observations route and expose them to the list page as operator-facing import/filter choices.
- Use seeded/imported Reference Record attributes, especially `tcgdex-set-id`, to derive the provider `setId` when an operator selects an Expansion.
- Preserve a manual TCGdex Expansion ID input for valid expansions not seeded yet. This supports the existing first-slice behavior where promotion can create or update the reference hierarchy from provider data.
- Replace the free-text language code control with the existing known language selector to reduce invalid operator input.
- Keep all edits inside Catalog-owned route/UI contracts and tests. No domain, event, schema, or deployable-root changes are required.

## Repo Evidence

- `.codex/plans/20260515-catalog-tcgdex-integration.md` says the first implementation included Source Observations, TCGdex import, admin review pages, and review-first promotion.
- `.codex/plans/20260516-pokemon-reference-seeding.md` says TCGdex `set` maps to Catalog `Expansion`, seeded/promoted items use the `Expansion` reference field, and Source Observation UI copy should use Expansion.
- `bounded-contexts/catalog/docs/source-observation-integration.md` documents that TCGdex import accepts one language and expansion, maps provider set data into Catalog Expansion language, and promotion sets an `Expansion` reference value.
- Current code already contains the backend and route surfaces under `bounded-contexts/catalog/features/source-observations` and reference data under `bounded-contexts/catalog/features/reference-data`.
- Current admin list UI still renders the import modal as a language-code text input plus a raw `TCGdex Expansion ID` text input.

## Implementation Checklist

- [x] Extend the Source Observations admin route loader to fetch active Expansion Reference Records.
- [x] Extend Source Observations UI contracts with the minimal `ReferenceRecord` data needed by the import/filter panel.
- [x] Replace the import language text input with a language selector.
- [x] Add an Expansion picker backed by Catalog Reference Records, deriving `setId` from `tcgdex-set-id`.
- [x] Preserve a manual TCGdex Expansion ID fallback for expansions not yet known to Reference Data.
- [x] Show the selected expansion's useful Catalog facts without duplicating provider terminology.
- [x] Update focused UI tests for picker-driven import and manual fallback.
- [x] Run targeted Catalog UI tests and relevant type/static checks.
- [x] Run browser verification for the admin Source Observations import modal.

## Verification Notes

- `pnpm --filter @chase-sets/catalog run test -- features/source-observations/ui/source-observation-list-page.test.tsx` passed.
- `pnpm --filter @chase-sets/catalog run test` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- Browser verified `http://localhost:6902/catalog/source-observations` after password sign-in as `demo@chasesets.test`.
- Desktop screenshot saved at `.codex/artifacts/tcgdex-admin-integration/source-observations-import-desktop.png`.
- Mobile screenshot saved at `.codex/artifacts/tcgdex-admin-integration/source-observations-import-mobile.png`.

## Documentation To Promote

- No durable docs are expected because the Catalog policy is already documented. Update this plan with any contradiction found during implementation.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
