# Product Options Display

## Intent

Standardize product option presentation across Chase Sets with one design-system component that visually renders only selected option values, such as `Raw • Excellent` or `Graded • PSA • 10 Gem Mint`, while preserving accessible names that can include the full context needed by screen readers, image alt text, forms, and cross-context handoffs.

This change should reduce the current variation across chips, slash-separated strings, pipe-separated strings, labels inside titles, table cells, checkout summaries, cart lines, listing rows, offer rows, inventory rows, and item-detail commerce panels.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-product-options-display`
- Branch: `codex/product-options-display-component`
- Sandbox id: `22749c51`
- Dependency setup status: `pnpm run deps:install` completed
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known; `pnpm run sandbox:doctor` completed

## Owning Contexts

- Catalog owns `Dimension`, `Option`, `Product`, selected-option validity, canonical dimension order, and the `product_summary` boundary term.
- The design system owns the reusable UI pattern because the same visual presentation is needed across Discovery, Inventory, Marketplace, Checkout, and later order/fulfillment/notification surfaces.
- Discovery owns browse/detail presentation and product option selection UX.
- Inventory owns account-held stock for a resolved product and currently computes product summaries from Catalog product schemas.
- Marketplace owns listing/offer rows and accepts product summaries from Inventory and offer/listing commands.
- Checkout owns cart, buy-now, offer-intent, and checkout-session presentation after the handoff.

## Repo Evidence

- `bounded-contexts/catalog/README.md` says Products are valid selected Option combinations under a Catalog Item, and Product identity excludes labels and display order.
- `bounded-contexts/catalog/GLOSSARY.md` says UI copy may use `Options` and does not need to expose the formal model when simpler wording is clearer.
- `docs/architecture/bounded-context-structure.md` says Catalog owns `SelectedOptionEntry` and `product_id`; deployables should stay thin.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says the design system is the canonical marketplace UI source, required decision facts should stay visible, and accessibility comes before aesthetics.
- `packages/design-system/src/components/ui/marketplace.tsx` already has `ProductSelectionSummary` and `productSelectionDetailsFromSummary`, but the current visual output is label-value chips like `Form: Raw` and `Condition: Near Mint`.
- Discovery item-detail UI already uses `ProductSelectionSummary` in multiple locations for selected products, listings, and offers.
- Marketplace listing, listing detail, offer match, offer detail, and submitted-offer pages wrap `ProductSelectionSummary` in local `ProductSummaryChips` helpers.
- Inventory item list uses `ProductSelectionSummary`; inventory item detail still renders a plain `Product` label followed by raw `product_summary`.
- Checkout currently passes product summaries into `OrderIntentSummary` subtitles and cart/session UI tests still assert `Form: Raw | Condition: Near Mint`.
- Inventory summary generation and marketplace SQL read models currently generate dimension-labelled summaries such as `Form: Raw | Condition: Near Mint`.
- Discovery bulk-add search preview generates a comma-separated dimension-labelled summary: `Dimension: Option, Dimension: Option`.

## Resolved Decisions

- Standardize on one reusable design-system component, recommended name `ProductOptions`, not a family of per-context components.
- Use visual option-only rendering by default. The component should render values joined by a neutral separator: `Raw • Excellent`, `Graded • PSA • 10 Gem Mint`.
- Keep chip and inline variants in the same component rather than creating separate components. The variation is presentation density, not a different concept.
- Carry dimension labels in the component input even though visual output is option-only. Dimension context is needed for proper accessible labels and image-alt helpers.
- Include an accessible label prop and a deterministic default accessible name. Recommended default: `Product options: Raw, Excellent`; when dimension labels are available, use them in the accessible name only, for example `Product options: Form Raw, Condition Excellent`.
- Include an exported adapter helper that converts existing persisted summary strings into explicit option display values at route/read-model boundaries. `ProductOptions` itself must not accept raw summary strings.
- Include an exported helper for product media alt text, likely `productOptionsAltText(itemTitle, options)` or a more general formatter, so image alt text can say `Pikachu, Raw, Excellent` when the image is the only product identity cue.
- Keep the component in the design system public surface, likely near existing marketplace primitives first because that is where `ProductSelectionSummary` already lives.
- Replace `ProductSelectionSummary`; do not keep both as peer primitives because that would preserve variation.
- Pushback: one component is enough for display. A separate form-control component is not needed because choosing options belongs to Discovery/Catalog selection flows, while this request is about presenting resolved options.

## Closed Questions

1. Should this implementation be UI-only first, or should it also change generated/stored `product_summary` text to options-only at the source?

   Answer: keep visual display options-only while retaining dimension context in the component data model for aria labels and image alt text. Implement this as UI-only first; do not change stored/generated `product_summary` text in this pass.

   Repo evidence: Catalog owns Dimension and Option truth; UI copy may use simpler `Options`. Inventory, Marketplace, Checkout, Ordering, Fulfillment, Notifications, UCP, seeds, tests, and replayed events already carry or assert legacy `product_summary` strings. Inventory also currently checks `productSummary.includes("Form: Graded")`, so changing source summary text would create domain risk outside the component standardization goal.

   Consequence: route and read-model adapters may map existing summary payloads into explicit option display values, and callers with richer selected-option details should pass dimension labels plus option labels. A later product-summary source cleanup can move domain checks from summary text to selected option IDs.

## Open Questions

- None blocking for implementation.

## Implementation Checklist

- Completed: add the design-system primitive `ProductOptions` with:
  - `options?: readonly ProductOptionDisplayValue[]`
  - `variant?: "inline" | "chips" | "compact"`
  - `emptyLabel`
  - `ariaLabel`
  - stable wrapping/truncation behavior for mobile table/card surfaces
- Completed: export helper(s):
  - `productOptionsFromSummary(summary)`
  - `formatProductOptionsText(options)`
  - `formatProductOptionsAriaLabel(options, fallback)`
  - `formatProductImageAltText({ title, options, fallback })`
- Completed: update design-system tests to assert option-only visual text and accessible labels.
- Completed: removed `ProductSelectionSummary` and `productSelectionDetailsFromSummary`; callers use `ProductOptions` with explicit option display values.
- Completed: replace local summary parsing and product-summary display in Discovery public listing/seller and the item-detail registration cue.
- Completed: replace local `ProductSummaryChips` parsing wrappers in Marketplace listings and offers with `ProductOptions`.
- Completed: replace Inventory item list/detail product summary presentation.
- Completed: replace Checkout cart/session/start surfaces where product options are visible.
- Completed: replace Ordering and Fulfillment product summary chips after the greenfield legacy-removal pass.
- Completed: keep context-owned selection controls untouched unless they display the resolved product summary.
- Completed: remove duplicated local parsing helpers from migrated callers.
- Completed: removed component-level summary parsing; `ProductOptions` now receives explicit option display values only.
- Completed: after the greenfield cleanup request, removed the remaining local `ProductSummaryChips` compatibility shims and changed their call sites to use `ProductOptions` directly.
- Completed: replaced checkout session default product-option fallbacks with localized `ProductOptions` empty states after CI localization caught hardcoded `Standard` copy.
- Completed: run focused typecheck/tests for design system, Discovery, Inventory, Marketplace, Checkout, and affected route tests after dependency setup.

## Verification

- `pnpm --filter @chase-sets/design-system test` passed.
- `pnpm --filter @chase-sets/design-system typecheck` passed.
- `pnpm run check:no-any` passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit` passed.
- `pnpm run typecheck` passed before the final rebase; after the final rebase it timed out twice with no failure output, so the latest verification used the resolved subcommands above plus the affected package tests.
- `pnpm --filter @chase-sets/marketplace test` passed.
- `pnpm --filter @chase-sets/inventory test` passed with existing skipped tests.
- `pnpm --filter @chase-sets/checkout test` passed.
- `pnpm run check:localization` passed after replacing checkout session hardcoded `Standard` fallbacks.
- `pnpm --filter @chase-sets/discovery test` passed with existing skipped tests and jsdom `window.scrollTo` warnings.
- `pnpm --filter @chase-sets/ordering test` passed with existing skipped tests.
- `pnpm --filter @chase-sets/fulfillment test` passed with existing skipped tests.
- `rg "ProductSummaryChips|ProductSelectionSummary|productSelectionDetailsFromSummary|<ProductOptions[^\n>]*summary="` returned no matches.

## Documentation To Promote

- Updated `packages/design-system/MARKETPLACE_SYSTEM.md` with a short `Product Options Display Contract`.
- Consider adding a Catalog glossary UI-copy note clarifying that visible product option summaries should use option values only, while formal docs and admin authoring may still mention Dimensions.
- Consider updating `docs/GLOSSARY.md` only if `Product Options` becomes a cross-context display term rather than just a component name.

## Stress Test

- Normal flow: raw cards render as `Raw • Excellent`; graded cards render as `Graded • PSA • 10 Gem Mint`.
- Partial flow: incomplete selection renders an empty or guidance label without implying a sellable Product.
- Stale data/replay: old `Form: Raw | Condition: Near Mint` read models still display as `Raw - Near Mint`.
- Cross-context handoff: Checkout and Marketplace receive existing summary payloads and render consistently without depending on a specific delimiter.
- Failure/cancellation: offer/listing/cart rows with missing summaries fall back to `Standard` or route-owned empty copy.
- Low-value card economics: compact option-only text improves table density and buyer comparison without hiding price, quantity, fee, or seller trust signals.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
