# Mobile Buy Sell Panel

## Intent

Fix the mobile buy/sell panel on Discovery item detail pages so it no longer hides the bottom of the page behind a fixed overlay. The design-system layout should keep the panel as the last mobile content block and make it sticky only while it is naturally in flow.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-mobile-buy-sell-panel`
- Branch: `codex/mobile-buy-sell-panel`
- Sandbox id: `0fe503a4`
- Dependency setup status: complete; `pnpm run deps:install` succeeded.
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` succeeded.

## Owning Contexts

- Discovery owns the item detail presentation model and renders the product detail route where the mobile panel appears.
- Marketplace owns Listing and Offer lifecycle facts surfaced in the panel.
- The design system owns `MarketplaceProductDetailLayout`, marketplace layout behavior, sticky CTA contracts, tokens, and reusable marketplace patterns.

## Resolved Decisions

- Ownership: implement the behavior in `packages/design-system`, not in a Discovery route override. Repo evidence: `bounded-contexts/discovery/README.md` says Discovery owns item detail presentation, while `packages/design-system/README.md` makes the design system the canonical UI layer and forbids app-owned layout overrides.
- UI contract: `MarketplaceProductDetailLayout` should render `mobileActionBar` as an in-flow final mobile block with `position: sticky`, not `position: fixed`. Repo evidence: the current class is `fixed inset-x-3 bottom-20 z-sticky xl:hidden md:bottom-4`, and the screenshot shows this covering lower page content above the bottom nav.
- Cross-context behavior: no domain, API, read-model, event, or glossary change is needed. Marketplace terms remain `Listing`, `Offer`, `Submitted Offer`, and `Offer Match`; Discovery terms remain `Detail Page` and `Filter State`.
- Failure/stale data: the layout change must behave the same when offers/listings are empty, when filters show no matches, and when marketplace projections update asynchronously. It only changes placement, not data selection or marketplace visibility rules.
- Low-value card economics: keeping the panel reachable without covering comparison rows preserves the fast buy/sell workflow and avoids adding extra taps or modal steps.

## Implementation Checklist

- Completed: replaced the fixed mobile action bar wrapper in `MarketplaceProductDetailLayout` with an in-flow final element that keeps sticky positioning without a bottom offset and reserves bottom-nav safe space.
- Completed: preserved the desktop sticky commerce sidebar unchanged.
- Completed: added a design-system regression test that rejects the old fixed wrapper and verifies mobile commerce renders after product content.
- Completed: installed worktree dependencies before verification.
- Completed: ran focused design-system tests, design-system typecheck, repo static verification, and a temporary Playwright mobile visual check.

## Documentation To Promote

- The durable design-system contract should be reflected in `packages/design-system/README.md` or `packages/design-system/MARKETPLACE_SYSTEM.md` only if the component-level behavior is not self-evident from tests. Current guidance already says sticky CTAs should not cover content, so no new ADR is expected.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
