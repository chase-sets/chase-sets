# List At Price Action

## Intent

Reduce the Discovery item-detail `List at price` seller surface from an inline create-listing form into a compact action. When an account does not yet have the default Inventory `Listing stock` ship-from location, show a separate focused setup component that manages that prerequisite before listing.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-list-at-price-action`
- Branch: `codex/list-at-price-action`
- Sandbox id: `3b43f26b`
- Dependency setup status: complete (`pnpm run deps:install`)
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns the item-detail presentation and is the right home for the compact inline seller action.
- Marketplace owns listing lifecycle and still receives listing create/update calls through its API.
- Inventory owns Storage Locations, ship-from mapping, and automatic Listing stock setup.

## Resolved Decisions

- Keep `List at price` on the Discovery item-detail page as a one-click product action using the currently selected product, best listing price, and quantity `1`.
- Do not collect ship-from fields inside the `List at price` action.
- If the account lacks the default `Listing stock` Storage Location, show a separate `Ship-from setup` component backed by Inventory's `createStorageLocation` API.
- The setup component creates the default `Listing stock` location with `LISTING-STOCK` as the ship-from code, matching Inventory's automatic listing stock convention.
- Advanced sellers can continue to manage detailed storage locations from `/account/inventory/locations`; this change only removes the heavyweight prerequisite form from the item-detail action.

## Repo Evidence

- `bounded-contexts/discovery/README.md` says Discovery owns detail pages and browse-oriented presentation.
- `bounded-contexts/marketplace/README.md` says Marketplace owns Listing lifecycle and seller asking prices, but does not own inventory truth.
- `bounded-contexts/inventory/README.md` says Inventory owns storage locations and ship-from location mapping.
- `bounded-contexts/marketplace/docs/standard-listing-inventory-disclosure.md` says standard listing creation is product-first and asks for ship-from setup only when needed.
- `bounded-contexts/inventory/docs/automatic-listing-stock.md` says Inventory creates or reuses the account's default `Listing stock` Storage Location and requires minimal ship-from details when it does not exist.
- `bounded-contexts/discovery/routes/item-detail.tsx` previously embedded price, quantity, advanced inventory, and ship-from fields in the item-detail sell panel.

## Implementation Checklist

- [x] Replace the inline `ListingPriceForm` fields with hidden values and a single list/update action.
- [x] Add a separate item-detail ship-from setup component shown only when no default `Listing stock` location exists.
- [x] Add an item-detail action branch that creates the default `Listing stock` Storage Location through Inventory.
- [x] Update localized copy for the compact action and setup component.
- [x] Update focused item-detail tests so they lock the reduced action and separate setup behavior.
- [x] Run targeted verification from the worktree.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx`
- `pnpm run check:localization`
- `pnpm run check:no-any`
- `pnpm run check:structure`
- `pnpm run test:structure`
- `pnpm run verify:typecheck`
- `pnpm --filter @chase-sets/app-marketplace-web run build`

## Documentation To Promote

- No durable docs promotion expected; existing Marketplace and Inventory docs already describe this product-first flow and ship-from setup ownership.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
