# Localized Language Labels

## Intent

Replace visible catalog language codes such as `Language: en` and `Language: ja` with localized natural-language labels such as `English` and `Japanese`, while keeping language codes as API, persistence, filter, and event truth.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-language-labels`
- Branch: `codex/language-labels`
- Base: `main` at `4f492f63`
- Sandbox id: `11cae2e7`
- Sandbox port base: `7750`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox doctor: `pnpm run sandbox:doctor` completed.
- Setup caveats: local Node is `v26.1.0` while package engines request Node `24.x`; pnpm reported this as a warning, not a blocker.

## Owning Contexts

- Catalog owns canonical Catalog Item truth and the persisted/API `language_code` fact projected downstream.
- Discovery owns browse/search presentation, Search Results, Filter State, and the marketplace search UI where the screenshot badge is rendered.
- Inventory owns account-held stock UI that projects catalog item language for inventory items.
- Marketplace owns listing UI that projects catalog or inventory language into listing pages.
- Checkout owns cart UI that displays product language on saved purchase intent.
- Pricing owns recommendation UI that displays projected catalog item language for pricing decisions.
- The implementation should include all user-facing raw language badges found in these contexts, per user scope decision.
- Shared localization lives in `contracts/localization`; user-facing copy should use localization keys rather than hardcoded JSX text.

## Resolved Decisions

- Keep `language_code` in read models, API responses, query params, filters, and integration projections. The code is stable machine truth.
- Convert codes to localized labels only at UI/presentation boundaries.
- The Discovery filter select already has localized `English` and `Japanese` labels through `languageOptions`.
- `findLanguageLabel(language)` already resolves filter chip values to localized labels.
- The initial screenshot defect is `formatItemLanguage(item)`, which formats the badge through `discovery.features.search.ui.searchPage.language.code` with the raw code.
- Prefer a tiny localization-backed presentation helper for language-code labels instead of changing read-model shape or making Catalog publish display copy.
- The helper can live in `contracts/localization` if multiple bounded contexts consume it; that keeps it as an explicit localization contract rather than a deployable utility.
- Update localization keys so badges can display only the label (`English`, `Japanese`) rather than phrases like `Language: {language}`.
- Unknown or future language codes should fall back to the code, so new catalog data remains visible instead of disappearing.
- User selected broad scope: apply this to all visible raw language-code badges found in Discovery search, Inventory inventory-item pages, Marketplace listing pages, Checkout cart, Pricing recommendations, and Catalog admin list/detail display surfaces.

## Open Questions

- None. Scope is settled as a broad user-facing badge sweep.

## Implementation Checklist

- Completed: added `formatLanguageCodeLabel` in `contracts/localization`, covering `en` and `ja` initially with code fallback for unknown values.
- Completed: used the helper in Discovery search and item detail, Inventory inventory-item list/detail, Marketplace listing list/detail, Checkout cart, Pricing recommendation list, and Catalog admin list/detail display surfaces.
- Completed: kept Catalog admin language entry fields labeled as code entry where the operator is editing a machine code.
- Completed: retired `discovery.features.search.ui.searchPage.language.code`; the search result badge no longer renders `Language: {language}`.
- Completed: added or updated UI/localization tests proving `en` displays as `English` and `ja` displays as `Japanese` on changed surfaces where tests were cheap to add.
- Preserved: API/read-model assertions that `language_code` remains `en`/`ja`; no schema, projection, API, event, or query-param shape changed.
- Completed: ran focused tests for changed contexts.
- Completed: ran localization checks and repo typecheck.
- Completed locally: started the marketplace and admin UIs in the sandbox and visually verified representative badges on desktop and mobile.

## Documentation To Promote

- Completed: no domain glossary change was required because this is presentation formatting, not a new Catalog or Discovery term.
- Completed: updated `contracts/localization/README.md` because the language-label helper is a shared localization contract.

## Verification Evidence

- `pnpm exec vitest run contracts/localization/index.test.ts bounded-contexts/discovery/features/search/ui/search-page.test.tsx bounded-contexts/inventory/features/inventory-items/ui/inventory-item-pages.test.tsx bounded-contexts/marketplace/features/listings/ui/listing-list-page.test.tsx bounded-contexts/marketplace/features/listings/ui/listing-detail-page.test.tsx bounded-contexts/checkout/features/cart/ui/cart-page.test.tsx bounded-contexts/pricing/features/recommendations/ui/recommendation-list-page.test.tsx bounded-contexts/catalog/features/catalog-items/ui/catalog-item-detail-page.test.tsx`: passed, 8 files and 20 tests.
- `pnpm --filter @chase-sets/app-marketplace-web run test`: passed, 19 files and 78 tests.
- `pnpm --filter @chase-sets/discovery run test`: passed, 13 files and 58 tests, with 1 file and 3 tests skipped by existing suite configuration.
- `pnpm run check:localization`: passed for 374 source files.
- `pnpm run verify:typecheck`: passed after rerunning with a longer timeout; local Node still warns because it is `v26.1.0` while package engines request Node `24.x`.
- Production display-code sweep found no remaining direct `Language: en`, `Language: ja`, raw badge `en`/`ja`, or direct language-code field rendering in the changed UI surfaces.
- Browser desktop check at `http://localhost:7753/search?language=ja`: search result badge renders `Japanese`; no `Language: ja` raw-code display.
- Browser desktop check at `http://localhost:7752/catalog/catalog-items?language=ja`: Catalog Items language column renders `Japanese`; no `Language: ja` raw-code display.
- Browser mobile checks at 390x844 for marketplace search and admin catalog items: labels render as `Japanese` without overlap, and no raw `Language: ja` display appears.
- Signed-in marketplace DOM pass through account inventory, listings, cart, and pricing found no `Language: en`, `Language: ja`, raw `>en<`, or raw `>ja<` display.

## Goal Completion Criteria

- Implementation is completed in `D:\Users\ToddS\Source\Repos\chase-sets-20260513-language-labels` on `codex/language-labels`.
- The retained plan at `.codex/plans/20260513-language-labels.md` is committed with the implementation.
- All changed user-facing badge/display surfaces show localized labels (`English`, `Japanese`) rather than raw codes.
- Machine contracts still expose `language_code` values unchanged.
- Focused automated tests pass.
- Localization verification passes.
- Desktop and mobile marketplace/admin visual checks confirm the badges render correctly without overlap.
- Durable docs are promoted only if the implementation adds a cross-context shared pattern.
- A PR is submitted, CI passes, the PR is merged, and staging deploy verification confirms the behavior.
