# Product Detail Purchase Panel Accordion

## Intent

Clarify the product detail purchase panel by replacing action-looking mode buttons with a single-select accordion. Each buyer workflow owns its explanation, product/listing summary, form fields, and final CTA inside the expanded item.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-purchase-panel-accordion`
- Branch: `codex/purchase-panel-accordion`
- Sandbox id: `cb715857`
- Dependency setup status: `pnpm run deps:install` passed on 2026-05-18.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox status: `pnpm run sandbox:doctor` passed on 2026-05-18; Marketplace URL is `http://localhost:7753`.
- Setup blockers: none.

## Owning Contexts

- Discovery owns the Detail Page presentation model, item-detail route, Product Alert behavior, and the buyer-facing right rail composition.
- Checkout owns Cart and Checkout Session behavior. The UI change must preserve current add-to-cart and buy-now POST behavior instead of moving cart/session rules into Discovery.
- Marketplace owns Listing and Offer behavior. The UI change must keep Make offer product-scoped and avoid seller-specific language for offer submission.
- Catalog owns Product identity and selected options. The UI should describe product form/condition through the existing selected-options summary.

## Resolved Decisions

- Ownership: implement the panel in Discovery item-detail route/UI tests because this is a presentation interaction on the Discovery-owned Detail Page.
- Language: replace `Selected product intent` with `Your selection`, `Listing summary`, `Offer details`, or `Alert criteria`; replace `Selected seller signal` with user-facing price labels such as `Best available price` or `Selected price`.
- Behavior: render Buy now, Add to cart, Make offer, and Set alert as a single-select accordion under the existing Buy/Sell toggle and `Choose action` heading.
- Default open item: open Buy now when the selected product has a live listing; otherwise open Make offer when a product can be selected, with Set alert remaining available for matching-listing criteria.
- Buy now: keep the existing selected-listing logic and checkout handoff; show selected price, seller, availability, product selection, quantity, and a final `Buy now` CTA inside the expanded body.
- Add to cart: keep the existing add-to-cart fetcher behavior; show saved-for-later copy, selected price, seller, availability, product selection, quantity, and a final `Add to cart` CTA inside the expanded body.
- Make offer: keep the existing offer-intent checkout redirect and validation fields; frame the action as product-wide demand for matching product criteria, not a seller-specific listing action.
- Set alert: use the existing listing-side Product Alert create action in the buyer accordion; frame it as matching supply at or below maximum listing price.
- Accessibility: use focusable accordion header buttons with `aria-expanded` and panel/header association from the design-system accordion primitive; preserve reachable, clearly labeled submit CTAs inside panels.
- Design system: prefer the existing design-system accordion/card/form primitives. If richer controlled accordion behavior is needed, extend the design-system component rather than styling ad hoc local controls.
- Implementation: extended the design-system Accordion with controlled `value`/`onValueChange` support so Discovery can enforce a non-collapsible single-open purchase workflow without building a local accordion.
- Verification: focused Discovery item-detail commerce panel tests, design-system tests, localization check, no-`any` guard, design-system typecheck, root TypeScript check, and browser inspection at `http://localhost:7753/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp` passed in the worktree.

## Open Questions

- None. The request supplies enough behavior, language, and visual direction to proceed.

## Implementation Checklist

- Completed: Update the Discovery item-detail buyer commerce composition so the Buy side renders one `Choose action` accordion instead of separate buy/offer/alert panels.
- Completed: Split current purchase-intent UI rendering so Buy now and Add to cart are separate accordion items while reusing the existing hidden form data, quantity validation, selected listing, and add-to-cart fetcher behavior.
- Completed: Render Make offer and Set alert bodies inline in accordion items with product-wide language and compact label/value summaries.
- Completed: Add or update focused Discovery UI tests for accordion default selection, accordion header semantics, CTA placement, copy replacements, and preservation of add-to-cart/buy/offer/alert form fields.
- Completed: Run focused Discovery tests and typecheck/static checks appropriate to the touched packages.
- Completed: Localize new purchase workflow copy through the existing English locale contract.

## Documentation To Promote

- No durable docs are required unless implementation reveals a reusable commerce accordion pattern that belongs in `packages/design-system/`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
