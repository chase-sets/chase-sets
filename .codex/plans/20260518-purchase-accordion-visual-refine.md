# Product Detail Purchase Accordion Visual Refinement

## Intent

Refine the Discovery-owned item-detail purchase accordion so it keeps the single-select workflow model while feeling lighter, flatter, and easier to scan. The outer purchase panel should remain the primary boundary; accordion rows should behave like a section list with dividers, one active accent, and the final CTA as the only full-width primary button.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-purchase-accordion-visual-refine`
- Branch: `codex/purchase-accordion-visual-refine`
- Sandbox id: `15a83b65`
- Dependency setup status: `pnpm run deps:install` passed on 2026-05-18.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox status: `pnpm run sandbox:doctor` passed on 2026-05-18; Marketplace URL is `http://localhost:10653`.
- Setup blockers: none.

## Owning Contexts

- Discovery owns the Detail Page presentation model and the item-detail buyer purchase panel. The refinement belongs in `bounded-contexts/discovery/routes/item-detail.tsx` and focused Discovery route tests.
- Checkout continues to own cart intent and checkout session behavior. The change must preserve existing hidden form fields, add-to-cart fetcher behavior, buy-now handoff, quantity validation, and selected-listing logic.
- Marketplace continues to own listing and offer workflows. Make offer and Set alert copy should stay product-wide and must not imply a seller-specific workflow.
- The design system owns reusable accordion structure and tokens. If a flatter section-list accordion style is needed, extend the existing design-system Accordion API instead of local route-only styling.

## Resolved Decisions

- Keep the current one-open, non-collapsible accordion behavior and the Buy/Sell toggle.
- Keep the `Choose action` heading, but change helper copy to `Choose what you want to do with this item.`
- Render buyer options in the requested order: Buy now, Add to cart, Make offer, Set alert.
- Use the outer `FormPanel` as the primary card. The accordion should be a flat section list with internal dividers rather than a bordered card inside the panel.
- Add a design-system Accordion variant for flat section-list use. Existing default Accordion behavior should remain compatible for other callers.
- Make the active item obvious through a subtle left accent rail, active icon/header color, and spacing, not a nested card.
- Change Buy now and Add to cart summaries from `KeyValueList` to receipt-style inline content: prominent price, seller plus availability on one line, product criteria on one line, trust badges, quantity, and the final CTA.
- Change Make offer and Set alert inline bodies to avoid nested `FormPanel` surfaces and avoid seller-specific fields. Use compact product criteria and matching count text, then form fields and CTA.
- Use user-facing copy only; do not use `Selected product intent` or `Selected seller signal`.
- Preserve design-system tokens and current dark theme. Avoid new custom component systems or bespoke CSS outside existing token utility classes.

## Open Questions

- None. The request defines the visual, copy, interaction, and accessibility requirements with enough precision to implement.

## Implementation Checklist

- Done: Update the design-system Accordion with a lightweight section-list variant, active-state styling, compact collapsed rows, and controlled single-open behavior unchanged.
- Done: Update Discovery item-detail action card composition so the buyer panel passes the flat accordion variant and helper copy while preserving seller behavior unless the shared component naturally benefits without changing semantics.
- Done: Flatten buyer workflow bodies by rendering plain `FormPanel` content inside the accordion body and replacing key/value table summaries with receipt-style layouts.
- Done: Update Buy now/Add to cart helper copy, CTA labels, and summary text so immediate checkout and saved selection are visually and verbally distinct.
- Done: Update Make offer and Set alert body copy and summary layout so they clearly apply to matching product criteria and not a selected seller.
- Done: Update English locale keys for the new helper copy and any new receipt-style labels.
- Done: Update focused Discovery UI tests for copy, aria-expanded behavior, one-open behavior, flattened/no internal key-value labels, product-wide offer/alert language, and final CTA placement.
- Done: Run focused Discovery tests, design-system tests/typecheck, root TypeScript check, localization check, no-any guard, and whitespace check.
- Done: Browser-verify the marketplace item-detail page at `http://localhost:10653` using this worktree's marketplace web process and the already-running local platform API from the prior sandbox. The current sandbox could not create another Docker network because the local Docker address pool is exhausted.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx`: passed.
- `pnpm --filter @chase-sets/discovery run test`: passed.
- `pnpm --filter @chase-sets/design-system run test`: passed.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit`: passed.
- `pnpm run check:no-any`: passed.
- `pnpm run check:localization`: passed.
- `node ./scripts/run-workspaces.mjs typecheck --concurrency=4`: passed.
- `git diff --check`: passed.
- Browser QA: verified Buy now default expansion, Make offer expansion, Set alert expansion, one-open behavior, product-wide offer/alert copy, receipt-style selection content, and CTA placement in the in-app browser.

## Documentation To Promote

- No durable docs are required. This is a presentation refinement of an existing Discovery-owned route and a small design-system Accordion variant.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
