# Item Detail Action Cards

## Intent

Simplify the item-detail right rail so Buy and Sell each present one decision card first. The selected action then reveals only the necessary form or handoff. This reduces visual load while preserving buyer checkout, buyer cart, offers, product alerts, offer acceptance, sell-list batching, and listing creation.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-item-detail-action-cards`
- Branch: `codex/item-detail-action-cards`
- Sandbox id: `738cd7c9`
- Dependency setup status: complete; `pnpm run deps:install` succeeded and `pnpm run sandbox:doctor` reported the sandbox ports.
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns item-detail presentation, product selection, and Product Alerts.
- Marketplace owns Listings, Offers, Offer Acceptance, and seller sell-list batching.
- Checkout owns cart intent and checkout session orchestration.
- Inventory remains the owner of seller stock and listing stock creation.

## Resolved Decisions

- Use Discovery as the UI owner because the right rail is part of the Discovery Detail Page.
- Keep downstream behavior in existing action intents: `buy-now`, `add-to-cart`, `submit-offer`, `create-product-alert`, `sell-now`, `add-to-sell-list`, and `list-at-price`.
- Replace separate right-rail Buy, Offer, Alert, Sell, and List blocks with one Buy action card and one Sell action card.
- Buy actions: `Buy now`, `Add to cart`, `Make offer`, `Set alert`.
- Sell actions: `Sell now`, `Add to sell list`, `List for sale`, `Set alert`.
- `Add to sell list` is a first-class seller equivalent to cart because accepting multiple offers from the same account can improve shipping allowance efficiency by 5%.
- Selecting an action should reveal the necessary form inline in the same card for desktop and mobile.
- Keep wording natural and transaction-facing; avoid exposing internal nouns beyond established terms such as cart, offer, listing, and alert.

## Pressure Test

- Normal buy flow: a buyer sees one card, buys immediately, adds to cart, makes an offer, or creates a listing alert without scanning multiple panels.
- Normal sell flow: a seller sees one card, accepts the selected demand, batches the offer into a sell list, lists inventory, or watches offer demand.
- Partial selection: when product options are incomplete, actions remain disabled or route the user back to product option selection.
- Stale market data: existing action handlers still validate through Checkout, Marketplace, Discovery Product Alerts, and Inventory before mutation.
- Cross-context handoff: Discovery only selects and presents intent; owning contexts keep command validation.
- Failure/cancellation: form errors remain surfaced inside the selected action content rather than expanding every possible form.
- Low-value card economics: seller batching stays visible because the 5% shipping allowance can make multi-offer acceptance materially better for low-value cards.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Add Discovery item-detail action card components using design-system primitives only.
- [x] Recompose desktop and mobile commerce surfaces around one Buy card and one Sell card.
- [x] Preserve existing form intents and hidden selected-product fields.
- [x] Update item-detail commerce panel tests for progressive action selection.
- [x] Run focused tests and static checks relevant to Discovery/localization.

## Verification

- `pnpm --filter @chase-sets/discovery run test` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:no-any` passed.
- `pnpm run check:structure` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed.
- Playwright visual check against sandbox marketplace `http://localhost:7253/items/pikachu-jungle-60-64-common-cat-seed-pikachu-jungle-1kwaurr` confirmed one Buy card and one Sell card with action expansion.

## Documentation To Promote

- No durable architecture docs expected beyond this retained implementation plan unless the action-card pattern becomes a reusable design-system pattern.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
