# Catalog Offer Row Highlighting

## Intent

Update the catalog item detail marketplace rows so selected listing rows no longer repeat "Selected for checkout", the selected indicator spans the full row height, and public offer rows use the same row structure and visual treatment from the listing side.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-catalog-offer-row-highlighting`
- Branch: `codex/catalog-offer-row-highlighting`
- Sandbox id: `0816cbbc`
- Dependency setup status: `node .\scripts\worktree-deps.mjs install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: None. `pnpm run sandbox:doctor` completed and reported marketplace at `http://localhost:10003`.

## Owning Contexts

- Discovery owns catalog item detail presentation, including detail-page listing and offer rows.
- Marketplace owns Listing and Offer lifecycle and visibility facts projected into Discovery.
- Catalog owns Product identity and selected option truth, but no Catalog behavior changes are needed.
- Checkout owns checkout session orchestration; removing redundant listing-row copy does not change checkout state.

## Resolved Decisions

- Ownership: implement in `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`, keeping deployables as thin composition roots.
- Language: remove "Selected for checkout" from listing rows because the selected action button already names the selected row.
- Highlighting: keep selected rows visually distinct with the existing accent border and a full-height left accent strip.
- Offer row parity: render offer rows with the same responsive row shell as listing rows, adapted to offer terms: price, buyer, product, action.
- Events/read models/APIs: no domain event, projection, schema, or API contract changes; this is a Discovery UI presentation update.
- Tests: focused item-detail commerce panel test passed with the updated listing/offer row assertions.
- Visual proof: start the marketplace sandbox, open the changed item detail surface, and capture screenshots before PR submission.

## Implementation Checklist

- [x] Remove selected listing secondary copy.
- [x] Extend the selected listing left accent to the full row height.
- [x] Convert offer rows to the same listing-row shell and selected action affordance.
- [x] Remove unused localization copy if no longer referenced.
- [x] Update focused tests for listing/offer row behavior.
- [x] Run focused item-detail verification command.
- [x] Capture screenshots of changed listing and offer rows.
- [ ] Submit PR after screenshots are available.

## Documentation To Promote

No durable product documentation is expected. The change follows existing Discovery and Marketplace ownership docs.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
