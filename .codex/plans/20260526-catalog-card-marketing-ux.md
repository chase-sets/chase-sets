# Catalog Card Marketing UX

## Intent

Improve the catalog search result card after the staging review showed that the density pass became too row-like on desktop. The next layout should feel like a marketplace product browse surface: product media is prominent, card content scans cleanly, and Buy / Sell / Watch actions have a clear hierarchy without making every card feel like an operational form.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-catalog-card-marketing-ux`
- Branch: `codex/catalog-card-marketing-ux`
- Sandbox id: `468d3378`
- Dependency setup status: `pnpm run deps:install` passed
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Discovery owns the browse and search result experience in `bounded-contexts/discovery/features/search`.
- The design system owns marketplace card presentation through `packages/design-system/src/components/ui/marketplace.tsx` and the marketplace direction doc.
- Deployables remain thin composition roots; route tests can verify composed search behavior but should not own layout policy.

## Screenshot Audit Findings

- Desktop cards no longer feel like product cards. The image is too small relative to each card, leaving a dense text/action row that weakens product appeal and visual comparison.
- The wide primary `Sell` bar dominates the card in an awkward way. It is clearly primary, but it reads like a full-width form submit repeated down the page instead of a marketplace browse action.
- Secondary `Buy` and `Watch` actions are too small and detached below the primary bar. The hierarchy is clearer than before, but the interaction feels fiddly.
- The two-column row grid creates vertical drag without gaining enough product confidence. It fits more text per row, but the page no longer looks like a catalog marketplace.
- Mobile should stay compact, but desktop needs a gallery-oriented card that lets the product image, title, market status, and one action work together.

## Resolved Decisions

- Use a gallery card on desktop search results and compact horizontal cards below desktop. This keeps mobile/medium scan speed while restoring marketplace product appeal on large screens.
- Restore three-column desktop result grids once the card is no longer split into narrow image and info columns. The prior cramped issue came from a horizontal two-column card inside a three-column grid, not from three columns themselves.
- Keep Catalog's crisp image source contract: the rendered product image must stay within the `search-card` role's CSS-size contract so the 320w source can serve high-DPR displays.
- Keep metadata suppressed before the title. Default language and common blueprint labels should not return to the per-card top block.
- Remove search-result promotion/status badges from the card body. Demand/supply state belongs in market copy and action hierarchy, not as a badge competing with the collectible image.
- Make the dominant action card-sized but not page-wide on desktop. Buy or Sell remains primary; the opposite trade-side intent and Watch remain visible secondary actions in a compact row.

## Implementation Checklist

- Completed: updated the search result grid to use a desktop three-column gallery after card layout supports it.
- Completed: updated the design-system search-result `ListingCard` layout so desktop cards stack media above content while mobile remains compact horizontal.
- Completed: tuned search-result image, typography, market signal, and action spacing to reduce row-like drag.
- Completed: updated Discovery, route, and design-system tests to assert the new gallery hierarchy.
- Completed: updated marketplace design-system docs with the desktop gallery / mobile compact rule.

## Verification Notes

- Focused unit/component tests passed for design-system, Discovery search UI, and marketplace search route.
- Local Playwright review passed at `http://localhost:9803/search` in desktop and mobile viewports.
- Desktop dark-mode measurements: three result columns at about `349px`, first-card image renders `128 x 176` CSS pixels, first-card height is about `424px`, and Buy / Sell / Watch remain visible as compact actions.
- Mobile measurements: one result column at `358px`, first-card image renders `100 x 144` CSS pixels, and compact horizontal card behavior is preserved.
- `pnpm run verify:static` passed with the existing unrelated Discovery item-support structure warning.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:build` passed with existing large bundle chunk warnings.

## Documentation To Promote

- `packages/design-system/MARKETPLACE_SYSTEM.md` should document that search result cards use gallery cards on desktop and compact horizontal cards on smaller screens.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
