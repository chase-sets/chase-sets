# Item Detail Image Selector

## Intent

Move the item detail image selector from below the main image to the left side of the main image. Keep the existing item-detail media column width stable by shrinking the main image frame to make room for the vertical selector.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260519-item-detail-image-selector`
- Branch: `codex/item-detail-image-selector`
- Sandbox id: `92d34324`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` completed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Discovery owns the buyer-facing Detail Page and item-detail route. Evidence: `bounded-contexts/discovery/README.md` says Discovery owns browse, search, and detail experiences; `context.json` declares `item-detail` as an owned slice and contributes the `items/:id` route to `marketplace-web`.
- Design System owns reusable UI components and patterns. Evidence: repo instructions name it as the canonical source of truth for UI components, and item detail already uses `ImageGallery` from `packages/design-system`.

## Resolved Decisions

- Ownership: make the item-detail usage change in Discovery and add a reusable gallery thumbnail placement option in the Design System rather than composing a one-off custom selector in the route.
- Language: keep existing terms `Detail Page`, `image`, and thumbnail selector language; no glossary changes are needed.
- Invariants: this is a presentation-only change. It does not alter Discovery read models, events, APIs, product selection, listing matching, offer behavior, or checkout handoff.
- UI: add a left-placement thumbnail rail to `ImageGallery`, then use it only on item detail with a narrower main image cap. The outer media column stays governed by `MarketplaceProductDetailLayout`; the main image shrinks inside that column.
- Tests: update Design System coverage for the new placement behavior and Discovery item-detail tests for the new constrained media classes.

## Open Questions

- None. The screenshot and request specify left-side selector placement and stable column width.

## Implementation Checklist

- [x] Install or verify worktree dependencies.
- [x] Add `thumbnailPlacement` support to `ImageGallery`.
- [x] Use left thumbnail placement on Discovery item detail.
- [x] Shrink the item-detail main image frame to accommodate the selector.
- [x] Update focused tests.
- [x] Run focused test verification.

## Documentation To Promote

- None expected. This is a narrow UI component capability and one page-level use.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
