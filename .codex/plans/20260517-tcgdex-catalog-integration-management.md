# TCGDex Catalog Integration Management

## Intent

Catalog admins need an operational view of provider-fed catalog data before and after promotion. The first provider is TCGDex, but the UX should be shaped around Catalog-owned provider Source Observations so future integrations can appear without moving behavior into a deployable.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-tcgdex-catalog-integration-management`
- Branch: `codex/tcgdex-catalog-integration-management`
- Sandbox id: `9ea87f71`
- Dependency setup status: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` completed and assigned admin web to `http://localhost:6252`.

## Owning Contexts

- Catalog owns the behavior, read models, API, routes, UI, and tests.
- The existing `source-observations` slice is the canonical home because Catalog already owns provider Source Observations, provider keys, external keys, source hashes, normalized candidate fields, review status, and promotion.
- Deployables remain thin composition roots through `context.json` route and shell contributions only.

## Resolved Decisions

- Ownership: keep the integration management surface inside Catalog's `source-observations` slice rather than adding deployable-owned admin code or a separate integration context.
- Language: use `Integration` for the admin-facing management surface and keep `Source Observation` for record-level review and promotion.
- Read model: derive an integration scope summary from `catalog_source_observations`, grouped by provider, language, expansion/set, and series. Do not add a new aggregate until the system needs provider configuration state or job history.
- API: add a Catalog API endpoint for integration scopes before the `/:id` observation detail route.
- UI: add a Catalog admin `Integrations` route that shows provider/language/set/series coverage, observed/promoted/rejected counts, last observed time, and direct actions to review matching observations or import another TCGDex expansion.
- Operations: keep the existing import, scoped review, and scoped promote behavior. The overview should make the correct scope visible and navigable.

## Implementation Checklist

- [x] Add a source-observation read-model query that summarizes provider integration scopes.
- [x] Expose the summary through the source-observation API and browser client.
- [x] Add a Catalog-owned Integration Management page and route.
- [x] Add `Integrations` to the Catalog admin shell and route manifest.
- [x] Cover API, read-model, and UI behavior with focused tests.
- [x] Verify the bounded context structure, Catalog test suite, admin-web tests, typecheck, and admin-web build.

## Documentation To Promote

- [x] Updated `bounded-contexts/catalog/docs/source-observation-integration.md` with the management-surface policy.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
