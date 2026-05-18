# Mobile Commerce Accordion Rail

## Intent

Make the mobile commerce drawer match the desktop purchase accordion pattern: one panel surface, active section rail at the panel edge, active background to the same edge, and no nested action card. If the existing components cannot express that cleanly, promote the behavior into a reusable design-system concept.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-mobile-accordion-rail`
- Branch: `codex/mobile-drawer-rail-match-desktop`
- Base: `origin/main`
- Sandbox id: not created for this refinement; local marketplace dev server is running on `http://localhost:11657`.
- Dependency setup status: dependencies available from the worktree.
- pnpm store path: inherited workspace pnpm store.
- Setup blockers: none.

## Owning Contexts

- Design system owns framed panels, scroll body layout, accordion section-list behavior, and reusable edge-aligned rail patterns.
- Discovery owns item-detail purchase workflow composition and the mobile buy/sell drawer wiring.
- Checkout and Marketplace own the underlying buy, cart, offer, alert, and sell/list behavior; this change must not alter submitted fields, validation, selected listing logic, or availability rules.

## Resolved Decisions

- Add a reusable panel body layout, `bodyLayout="edge"`, so panel contents can intentionally bleed to the framed panel edge without fighting the scroll-area defaults.
- Replace the ad hoc accordion `bleed` wording with `edge`, using `edge="panel"` for mobile drawers and `edge="compact"` for compact desktop sidebars.
- Add `PanelSectionAccordion` as the design-system concept for accordions that behave like panel section lists rather than standalone cards.
- Keep the active rail and active background on the accordion item surface, with the final CTA remaining the only full-width primary button.
- Preserve the current buy and sell accordion workflows, validation, default action selection, and accessibility semantics.

## Implementation Checklist

- Done: Add design-system panel edge scroll layout.
- Done: Add reusable panel section accordion concept and migrate purchase accordions to it.
- Done: Add panel-section accordion bottom anchoring during the expansion window so lower active sections can remain fully visible without a delayed snap.
- Done: Mask first/last panel-edge accordion sections with the panel radius so active rails do not draw past rounded edges.
- Done: Convert the panel-edge rail from a border to an internal clipped pseudo-element so the radius mask works even when the drawer is scrolled away from the bottom.
- Done: Add the bottom radius mask to the edge scroll viewport so clipped rails respect the drawer radius even when the active section extends below the visible area.
- Done: Remove legacy `bleed` terminology from the design-system accordion API and Discovery usage.
- Done: Run focused tests, typechecks, build, and browser screenshot verification.
- Done: Show screenshot in chat before PR merge.
- Pending: Submit PR and leave it unmerged until visual approval.

## Verification

- `pnpm --filter @chase-sets/design-system run test -- design-system-parity.test.tsx`: passed.
- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx`: passed.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm exec tsc -p ./tsconfig.json --noEmit`: passed.
- `pnpm --filter @chase-sets/app-marketplace-web run build`: passed.
- `pnpm run check:no-any`: passed.
- `git diff --check`: passed.
- Browser QA at `http://localhost:11657`: verified the visible mobile accordion root and active section begin at `x=13`, immediately inside the drawer border at `x=12`; the active section has a `4px` accent border and its background spans to the drawer edge.
- Browser QA for the last open accordion item: verified the active Set alert section, accordion root, and edge scroll body all bottom at `945px`, the drawer's inner bottom edge.
- Browser QA for sell-mode Set alert bottom anchoring: verified the active item is bottom-aligned at the first measured frame and remains aligned after settling, with scrollTop stable at `109`.
- Browser QA for rail masking: verified the active last item has `overflow: hidden`, `16px` bottom-left radius, and the rail remains clipped to the rounded edge.
- Browser QA for scrolled-top rail masking: verified the active last item uses no left border, keeps the internal rail pseudo-element, and remains clipped while the scroll area is at `scrollTop: 0`.
- Browser QA for scroll viewport masking: verified `panel-edge-scroll-area` has `16px` bottom-left radius and clips the internal rail at `scrollTop: 0`.

## Documentation To Promote

- No durable docs beyond this plan are required; the reusable API and tests document the pattern.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
