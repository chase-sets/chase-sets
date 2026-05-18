# Product Detail Purchase Panel Outer Rail Refinement

## Intent

Refine the Discovery item-detail purchase panel so the right-side buyer workflow reads as one coherent purchase card. The accordion should stay single-select, but the active blue rail should move to the outermost left edge of the panel and align only with the currently expanded section. The expanded content should remain on the panel surface with dividers, not inside another visual container.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-purchase-panel-outer-rail`
- Branch: `codex/purchase-panel-outer-rail`
- Base: `origin/main` at `ae044e8d Refine purchase accordion visual hierarchy (#192)`
- Sandbox id: `9fee7b3d`
- Dependency setup status: `pnpm run deps:install` passed on 2026-05-18.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox status: `pnpm run sandbox:doctor` passed on 2026-05-18; Marketplace URL is `http://localhost:9253`.
- Setup blockers: none.

## Owning Contexts

- Discovery owns the item-detail purchase panel composition, route presentation, selected listing read behavior, buyer workflow copy, and focused route tests.
- The design system owns reusable Accordion behavior and visual variants. The active rail should be an Accordion pattern option rather than route-only custom styling so this section-list pattern remains consistent anywhere else it is used.
- Checkout still owns cart and checkout behavior; this change must preserve form fields, quantity validation, add-to-cart fetcher behavior, and checkout handoff.
- Marketplace still owns listing and offer workflows; Make offer and Set alert remain product-criteria workflows, not seller-specific workflows.

## Resolved Decisions

- Keep the existing Buy/Sell toggle, `Choose action` heading, helper copy, action order, default expanded action rules, validation, selected-listing logic, and accessibility behavior.
- Extend the design-system Accordion section-list variant with an outer-edge active rail option. The rail belongs to the host card edge, while section rows keep only dividers and subtle active text/background treatment.
- Add enough panel-level structure in Discovery for the rail to sit on the outermost left edge of the purchase card without adding another card or border.
- Remove the repeated Buy now/Add to cart helper copy from the expanded body. The header helper remains the workflow explanation; the body starts with `Your selection`.
- Keep receipt-style buyer summaries and product-criteria offer/alert summaries. No table-like summary rows or seller-specific offer/alert fields.
- Preserve dark theme and token utility classes. Avoid bespoke route CSS beyond design-system-provided Accordion classes and existing layout primitives.

## Open Questions

- None. The request defines the visual, interaction, copy, and accessibility requirements precisely.

## Implementation Checklist

- Done: Update the design-system Accordion API so the section-list variant can render an outer-edge active rail that aligns with the open item, while default Accordion behavior remains unchanged.
- Done: Remove the current inner active rail from section-list items so the accordion does not look like its own nested action container.
- Done: Update the Discovery buyer action card composition so the right purchase panel is a single relative card surface and the Accordion rail can sit at the card's outer edge.
- Done: Remove repeated Buy now/Add to cart helper copy from expanded purchase bodies while keeping the receipt details and final CTA.
- Done: Update focused Discovery tests for the one-card/outer-rail pattern, one-open behavior, product-wide offer/alert content, and removed repeated body helper copy.
- Done: Update design-system tests for the new section-list active rail behavior and default variant compatibility.
- Done: Run focused Discovery tests, design-system tests/typecheck, root TypeScript check, localization check, no-any guard, workspace typechecks, whitespace check, and browser QA.
- Pending: Submit PR, wait for CI, merge, and verify staging and production deployments.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx`: passed.
- `pnpm --filter @chase-sets/discovery run test`: passed.
- `pnpm --filter @chase-sets/design-system run test`: passed.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit`: passed.
- `pnpm run check:no-any`: passed.
- `pnpm run check:localization`: passed.
- `node ./scripts/run-workspaces.mjs typecheck --concurrency=4`: passed.
- `pnpm --filter @chase-sets/app-marketplace-web run build`: passed.
- `git diff --check`: passed.
- Browser QA at `http://localhost:11653`: verified the actual desktop commerce rail uses one `glass-surface`, no inner `modern-surface`, compact edge bleed, active rail offset about one pixel from the purchase card border, Buy now default expansion, and rail movement for Make offer and Set alert.

## Documentation To Promote

- No durable docs beyond this plan are required. This is a design-system pattern refinement plus Discovery route composition.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
