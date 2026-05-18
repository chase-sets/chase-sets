# TCGDex Catalog Preload

## Intent

Improve the Catalog TCGDex integration so operators can load new Pokemon TCG expansions by choosing a supported language, series, and expansion from preloaded provider metadata instead of manually looking up TCGDex expansion IDs.

The change should keep Catalog as the behavior owner, keep TCGDex data behind the Source Observation and Reference Data slices, and avoid introducing a deployable-local provider cache.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-tcgdex-catalog-preload`
- Branch: `codex/tcgdex-catalog-preload`
- Sandbox id: `2f283970`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor status: complete via `pnpm run sandbox:doctor`
- Setup blockers: none

## Owning Contexts

- Catalog owns the change.
- Catalog Source Observations own provider import behavior and Source Observation review workflow.
- Catalog Reference Data owns Series and Expansion Reference Records.
- Discovery, Marketplace, Inventory, and Pricing should not own or directly call TCGDex metadata for this workflow.

Repo evidence:

- `bounded-contexts/catalog/README.md` says Catalog owns provider Source Observations before review and promotion into canonical Catalog Items, and Reference Types/Reference Records for rich reusable item facts.
- `bounded-contexts/catalog/GLOSSARY.md` defines Expansion and Series as Reference Record examples and says Reference Records enrich Catalog Items without changing Product identity.
- `bounded-contexts/catalog/docs/source-observation-integration.md` says TCGDex provider data writes Source Observations first, and promotion sets the Catalog Item Expansion field as a Reference Record value.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` currently creates Series and Expansion Reference Records as a side effect of promotion through `ensurePokemonReferenceHierarchy`.
- `bounded-contexts/catalog/features/source-observations/ui/source-observation-list-page.tsx` currently asks operators to type a language code and TCGDex expansion ID.

External provider evidence:

- TCGDex REST docs state the current v2 API is GET-only JSON over HTTPS.
- TCGDex exposes `https://api.tcgdex.net/v2/{language}/series`, `https://api.tcgdex.net/v2/{language}/series/{seriesId}`, and `https://api.tcgdex.net/v2/{language}/sets`.
- The live English `series` response returns IDs and names such as `base`, `swsh`, `sv`, and `me`.
- The live English `sets` response returns IDs, names, logos/symbols when available, and card counts, including `me02.5` for `Ascended Heroes`.
- TCGDex status pages expose supported language names and completion status, but the API status response is HTML today, so implementation should use a conservative supported-language constant unless a stable JSON endpoint is found during implementation.

## Resolved Decisions

- Ownership: Catalog owns preloading and import selection because Source Observations and Reference Records are Catalog concepts.
- Language: Use `languageCode` at APIs and UI state, normalized through the existing BCP 47-compatible language code helpers. UI labels should use existing `formatLanguageCodeLabel`.
- Provider term: Keep external implementation names as `set` where matching TCGDex endpoints, but Catalog-facing UI/API copy should say `Expansion`.
- Data model: Preloaded Series and Expansion metadata should be represented as Catalog Reference Records, not a deployable-owned lookup table. TCGDex source IDs belong in Reference Record attributes (`tcgdex-series-id`, `tcgdex-set-id`).
- Import command: The import route can continue accepting `expansionId` for compatibility, but the admin UI should submit the selected expansion's TCGDex set ID under the existing request shape.
- Reference identity: Deterministic keys should be derived from provider identity, language, and TCGDex IDs where needed so re-running preload is idempotent and does not create duplicate Reference Records when translated names differ.
- UI workflow: The Source Observations import dialog should load language options first, then series options for the selected language, then expansion options for the selected series. The primary action should stay "Import" and import only cards for the selected expansion.
- Failure handling: Metadata preload failure should block only the selector and show a retryable error. It should not mutate Source Observations. Card import failure behavior should remain unchanged.
- Backward compatibility: Keep raw `expansionId` request support and list filter support so existing route tests and deep links keep working.

## Implementation Checklist

- Add TCGDex metadata client functions in the Source Observations slice:
  - supported language options from a local Catalog-owned allowlist
  - list series for a language
  - list expansions for a language and optional series
  - optional single-set metadata fetch when the list endpoint lacks release date or abbreviation
- Add Source Observation service methods and routes for metadata:
  - `GET /source-observations/tcgdex/languages`
  - `GET /source-observations/tcgdex/series?languageCode=en`
  - `GET /source-observations/tcgdex/expansions?languageCode=en&seriesId=sv`
- Ensure the metadata preload path creates or revises Reference Types/Records for Manufacturer, Product Line, Series, and Expansion before card import, reusing the existing reference-data command handlers and projectors.
- Extract the existing `ensurePokemonReferenceHierarchy` logic so promotion and preload share one Catalog-local reference hierarchy writer.
- Update `SourceObservationListPage` import dialog to use selects for language, series, and expansion instead of raw text inputs.
- Keep a small fallback text input or disabled/error state only if metadata cannot be loaded, not as the default workflow.
- Add focused tests:
  - TCGDex client normalizes language/series/expansion metadata.
  - Source Observation routes expose metadata and keep the existing `expansionId` import contract.
  - Reference hierarchy preload is idempotent and prevents duplicate Series/Expansion records on replay.
  - Admin import UI selects expansion by name and submits the selected provider set ID.
- Update `bounded-contexts/catalog/docs/source-observation-integration.md` to describe metadata preload and the operator workflow.

## Stress Tests

- Normal flow: operator chooses English, Mega Evolution, Ascended Heroes; import sends `languageCode=en` and `expansionId=me02.5`, then Source Observations are recorded as today.
- Partial flow: language metadata loads but series fails; selector shows a retryable failure and no Source Observation command runs.
- Stale data: TCGDex adds a new expansion after the page loads; refreshing metadata should show it without requiring code changes.
- Replay/idempotency: rerunning preload for the same language/series/expansion should find existing Reference Records by provider attributes or deterministic keys and avoid duplicate records.
- Cross-context handoff: only promoted Catalog facts flow downstream; Discovery and Marketplace never call TCGDex.
- Failure/cancellation: closing the dialog during metadata load should not leave partial Source Observations; any Reference Records created by preload are durable Catalog reference facts and safe to keep.
- Low-value card economics: reducing manual ID lookup and import errors lowers operator friction for large low-value card expansions without changing review-before-promotion controls.

## Open Questions

None blocking. Recommended default is to preload metadata from TCGDex into Catalog Reference Records on demand when the import dialog loads or refreshes, while importing card observations only after the operator chooses a specific expansion.

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` with the metadata preload policy, routes, and operator flow.
- No ADR expected; this extends the existing Catalog Source Observation integration rather than changing a hard-to-reverse architectural decision.

## Implementation Notes

- Added TCGDex metadata reads for Catalog-facing language, Series, and Expansion selection.
- Added Source Observation metadata routes under `/source-observations/tcgdex/*`.
- Updated the Source Observations import dialog to select language, Series, and Expansion from preloaded metadata.
- Ensured import creates/reuses the Pokemon Reference Type and Reference Record hierarchy before recording Source Observations; promotion keeps the same safeguard.
- Updated reference lookup to reuse existing Series/Expansion records by TCGDex provider attributes as well as Catalog keys.
- Updated `bounded-contexts/catalog/docs/source-observation-integration.md` with the metadata preload and reference hierarchy policy.

Verification so far:

- `pnpm run check:localization`
- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/runtime.test.ts features/source-observations/api/tcgdex-client.test.ts features/source-observations/api/route.test.ts features/source-observations/ui/source-observation-list-page.test.tsx`
- `pnpm run typecheck`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `git diff --check`

## Goal Completion Criteria

- Implement Catalog-owned TCGDex language, series, and expansion metadata preload/query behavior.
- Replace manual TCGDex expansion ID lookup in the Source Observations admin import flow with language, series, and expansion selectors.
- Keep existing import route compatibility for `expansionId` and `setId`.
- Add focused unit/UI tests for client normalization, route/service behavior, idempotent reference preload, and admin import selection.
- Run targeted tests for Catalog Source Observations and relevant UI.
- Update durable Catalog docs.
- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
