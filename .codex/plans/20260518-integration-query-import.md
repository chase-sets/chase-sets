# Integration Query Import Experience

## Intent

Catalog admins should import provider-fed Source Observations by choosing natural Catalog-facing information, not by manually knowing provider IDs such as a TCGdex Expansion ID. TCGdex is the first provider, but the integration surface should make room for future providers to expose provider-specific lookup information through a consistent Catalog-owned query shape.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-integration-query-import`
- Branch: `codex/integration-query-import`
- Sandbox id: `f576e440`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Catalog owns this change.
- Owning slice: `bounded-contexts/catalog/features/source-observations`
- Supporting surfaces: Catalog admin routes, Catalog shell API client, localization copy, and the Catalog source-observation integration note.

Repo evidence:

- `bounded-contexts/catalog/README.md` states Catalog owns provider Source Observations before review and promotion into canonical Catalog Items.
- `bounded-contexts/catalog/GLOSSARY.md` defines Source Observation as a provider-sourced candidate record reviewed before becoming Catalog truth.
- `bounded-contexts/catalog/context.json` declares `source-observations` as the slice for provider observations, review workflow, and promotion.
- `bounded-contexts/catalog/docs/source-observation-integration.md` already says routine TCGdex admin loading should preload language, Series, and Expansion choices and keep raw Expansion IDs only for API compatibility and scripted operations.

## Resolved Decisions

- Keep provider import lookup behavior inside Catalog's `source-observations` slice. Provider lookup metadata is part of the Source Observation import experience, not a cross-context provider registry or deployable-owned concern.
- Introduce a provider-neutral Catalog Integration Query read API that can expose integration-specific option sets by provider and query kind. TCGdex will back `languages`, `series`, and `expansions`; future providers can add query kinds without adding new top-level ad hoc UI hooks.
- Keep the existing TCGdex-specific endpoints as compatibility adapters for the already-working Source Observations list flow, but move the Catalog Integrations admin screen toward the provider-neutral query API.
- Improve the Catalog Integrations admin import modal to use the same natural-language TCGdex selection flow as Source Observations: Language, Series, Expansion.
- Improve integration filters by replacing the raw TCGdex Expansion ID text field with a provider-aware Expansion selector when TCGdex is selected. Keep raw ID compatibility at URL/API boundaries through the existing `setId` query parameter.
- Use Catalog-facing labels in UI copy. Use `Expansion` for visible import/filter choices and reserve provider IDs for hidden values and API payloads.

## Open Questions

None blocking. The implementation can preserve raw-ID API compatibility while making routine admin paths lookup-driven.

## Implementation Checklist

- Completed: Add provider-neutral integration query contracts for option lists returned by Catalog.
- Completed: Add provider-neutral route/service/client functions under Source Observations, backed by existing TCGdex client functions.
- Completed: Refactor IntegrationManagementPage import modal from raw `Language Code` and `TCGdex Expansion ID` text inputs to Language, Series, and Expansion selectors.
- Completed: Replace the Catalog Integrations raw Expansion ID filter with a provider-aware Expansion selector when the selected provider is TCGdex; preserve the `setId` URL field and review links.
- Completed: Update UI tests for the Integrations screen and focused route tests for the generic query endpoint.
- Completed: Run focused Catalog source-observation UI/API tests and broader type/localization checks.

## Verification

- `pnpm --filter @chase-sets/catalog exec vitest run --config ./tests/vitest.config.mjs features/source-observations/api/route.test.ts features/source-observations/api/tcgdex-client.test.ts features/source-observations/ui/integration-management-page.test.tsx features/source-observations/ui/source-observation-list-page.test.tsx`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm run typecheck`
- `pnpm run check:localization`

## Documentation To Promote

- Update `bounded-contexts/catalog/docs/source-observation-integration.md` to document the provider-neutral integration query surface and the compatibility role of raw provider IDs.
- No ADR needed: this is an extension of existing Source Observation policy, not a hard-to-reverse system decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
