# Bulk Add Search Results To Cart

## Intent

Let buyers add many search-matched marketplace items to cart from Discovery search, covering examples like a newly released set or a tag-backed collection, while preserving Checkout's ownership of Cart intent and keeping the experience clear, reversible, and safe for large result sets.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-add-search-results`
- Branch: `codex/bulk-add-search-results`
- Base: current `main` HEAD at worktree creation, commit `612d59b6`
- Sandbox id: `f51be05b`
- Dependency setup: `pnpm run deps:install` succeeded on 2026-05-16
- Sandbox status: `pnpm run sandbox:doctor` succeeded; Marketplace default URL is `http://localhost:7553`
- Setup caveats: root repo `main` was behind `origin/main` by 2 commits before the worktree was created; branch intentionally follows the skill rule to branch from current repo HEAD unless a base is named.
- Local visual caveat: another worktree owned ports `7553` and `7653` during verification, so this feature worktree was checked at `http://localhost:7753`. The standalone marketplace dev server rendered the new search control at desktop `1280x720` and mobile `390x844`, but the backend API stack was not running for full seeded result interaction.

## Owning Contexts

- Discovery owns the search route, Discovery Query, Filter State, Result Set, facets, search UI, and buyer-facing bulk-add entry point.
- Checkout owns Cart, cart line events, cart write APIs, cart read models, guest cart behavior, and the mutation that adds lines.
- Catalog remains upstream for Catalog Item, Product identity, dimensions, options, fields, tags, categories, and reference data.
- Marketplace remains upstream for listing visibility signals projected into Discovery, but it should not own the bulk cart action.

## Resolved Decisions

- The implementation should keep deployables thin. Marketplace web should continue to compose Discovery and Checkout routes without owning search or cart behavior.
- Bulk add from search is cross-context orchestration: Discovery should present and preview the action from the Result Set, then call a Checkout-owned bulk cart write surface.
- Cart mutation must stay in Checkout rather than looping through individual Discovery item-detail actions. Existing single-line writes already merge duplicate product/fulfillment lines by increasing quantity, and the bulk surface should preserve that behavior.
- Result-set scope must be URL/query backed, not DOM backed. This lets "add the whole filtered set/tag" mean the active Discovery Query rather than only cards currently rendered on screen.
- Bulk add will require fully resolved Products for v1. Discovery should use current Product-defining Dimension filters and projected product schema to determine eligibility; unresolved Catalog Items should appear in preview as skipped/action-needed rather than becoming "any version" Cart lines.
- One bulk-add action may add all matching resolved Products from the active Discovery Query up to 250 eligible products in v1. Preview should show total matches, eligible count, skipped/action-needed count, and when the query exceeds the limit it should ask the buyer to refine before committing.
- The UI must use design-system components and patterns. Existing candidates include `BulkActionBar`, `SelectionToolbar`, `Checkbox`, `CommerceDrawer`, `Banner`, `Progress`, and existing search layout/filter primitives.
- Implementation uses a SearchPage action button plus a design-system `CommerceDrawer` preview/confirmation flow. The preview is returned from Discovery and the final commit re-previews server-side before calling Checkout.
- `SearchControlBar` now keeps desktop-only filters separate from actions so search actions remain reachable on mobile while language/category filters stay in mobile filter patterns.

## Repo Evidence

- `bounded-contexts/README.md` fixes Discovery as the owner of browse/search and Checkout as the owner of Cart.
- `bounded-contexts/discovery/README.md` says Discovery owns search query behavior, Result Sets, filter state, and browse read models, but not listing or transactional decisions.
- `bounded-contexts/checkout/README.md` says Checkout owns cart intent and checkout session lifecycle. Its invariant says Cart is mutable saved buyer intent.
- `bounded-contexts/checkout/features/cart/api/runtime.ts` validates each cart line against Checkout's projected catalog item and product schema, computes the canonical product id from selected options, and merges duplicate cart lines by increasing quantity.
- `bounded-contexts/checkout/features/cart/api/route.ts` currently exposes only single-line add/update/remove cart endpoints for account and guest carts.
- `bounded-contexts/discovery/features/search/api/route.ts` accepts `tag`, field filters, dimension filters, category, language, sort, limit, offset, and cursor.
- `bounded-contexts/discovery/routes/search.tsx` currently reads search/category/language/sort/page/dynamic filters, but does not read or preserve `tag`.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says dimension filters are carried into item detail links because they can select Products; field filters are intentionally not product selections.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` renders catalog-item result cards with market summaries, but current search result DTOs do not include `product_schema` or resolved `product_id`.

## Open Questions

None.

## Implementation Checklist

- [x] Add a Checkout-owned bulk cart write contract that accepts up to 250 resolved cart-line candidates for account and guest carts, returns added/merged/skipped/error counts, and keeps per-line validation in Checkout.
- [x] Add a Discovery-owned bulk-add preview for the active Discovery Query that resolves eligible products from current search filters, including tag/category/field/dimension filters, and explains skipped/action-needed items before the buyer commits.
- [x] Add tag filter handling to the Discovery search route/UI so tag-scoped bulk actions can be reached from buyer-facing search, not only the low-level API.
- [x] Add search UI affordances: current result-set bulk action, preview/confirmation drawer, disabled states for empty/unresolved/over-limit result sets, progress, success/error feedback, and cart-count update.
- [x] Keep mobile UX first-class: bulk affordance is in the focused search control area and confirmation uses the existing bottom-sheet `CommerceDrawer` pattern instead of introducing a separate overlay.
- [x] Add focused tests for Checkout bulk API behavior and SearchPage bulk controls/preview skip messaging.
- [x] Run bounded context structure checks, targeted Checkout, Discovery, and Design System tests, typecheck, marketplace production build, and local marketplace render checks at desktop and mobile widths. There is no repo-level `lint` script; static gates are structure, localization, no-any, and typecheck.

## Documentation To Promote

- Updated `bounded-contexts/discovery/docs/dynamic-search-filters.md` with the Discovery-owned bulk Result Set preview and Checkout cart handoff rule.
- Update `bounded-contexts/checkout/GLOSSARY.md` only if a new cart concept is introduced. Avoid glossary churn if bulk add remains a cart-line write workflow.
- Update `docs/GLOSSARY.md` only if a new cross-context term becomes necessary.
- Add design-system documentation only if a reusable bulk result-set pattern is added or generalized.

## Goal Completion Criteria

- Implementation remains in `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-add-search-results` on `codex/bulk-add-search-results`.
- The retained plan at `.codex/plans/20260516-bulk-add-search-results.md` is updated with final decisions and committed with the feature.
- Discovery owns search/query/preview UI behavior; Checkout owns cart mutation behavior; deployables stay composition roots.
- Automated checks pass, including targeted tests for Discovery and Checkout plus the repo's required structure/type/lint/test checks.
- Desktop and mobile marketplace visual checks verify search bulk add, preview/confirmation, success/error states, and cart count behavior.
- Durable docs are promoted where the final behavior creates lasting context or UX rules.
- A PR is submitted, CI passes, the PR is merged, preview deploy is verified and cleaned up, staging is verified, and production is verified after merge reaches `main`.
