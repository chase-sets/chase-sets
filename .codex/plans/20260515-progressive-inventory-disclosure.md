# Progressive Inventory Disclosure

## Intent

Make Inventory an advanced marketplace capability while keeping the standard listing workflow simple: an account should be able to create a listing without first understanding or managing Inventory directly, and every listing should still be backed by Inventory stock truth automatically.

Implementation is now in progress in this worktree. This plan remains the retained decision record and verification checklist for the progressive inventory disclosure change.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-progressive-inventory-disclosure`
- Branch: `codex/progressive-inventory-disclosure`
- Base: current source repo `main` at `8cc4f1e6` (`origin/main` is 35 commits ahead, not pulled because the workflow says branch from current repo HEAD unless the user names a base)
- Dependency setup: `pnpm run deps:install` completed successfully
- Sandbox id: `d70ccab6`
- Sandbox doctor: passed
- Marketplace URL for later implementation verification: `http://localhost:9503`
- Setup caveats: `pnpm run deps:install` reported existing cyclic workspace dependency warnings involving Checkout, Ordering, Marketplace seed testing, and Discovery; no setup failure.

## Owning Contexts

- Marketplace owns Listing lifecycle, listing publication, seller asking prices, available sell quantity exposed to buyers, and seller listing UI. Evidence: `bounded-contexts/marketplace/README.md`, `bounded-contexts/marketplace/GLOSSARY.md`, `bounded-contexts/marketplace/context.json`.
- Inventory owns account-held stock, operational availability, storage locations, ship-from mapping, holds, and imports. Evidence: `bounded-contexts/inventory/README.md`, `bounded-contexts/inventory/GLOSSARY.md`, `bounded-contexts/inventory/context.json`.
- Marketplace currently depends on Inventory availability signals and subscribes to Inventory item/hold/location events through `marketplace-inventory-supply-projection`.
- Inventory currently exposes marketplace-web inventory routes and top/bottom nav items (`Inventory`, `Import`), making Inventory first-class in the account navigation.

## Resolved Decisions

- The canonical term remains `Inventory Item` for account-owned stock truth and `Listing` for the seller-published ask.
- No glossary conflict found yet: the requested change affects disclosure and workflow, not the ownership of Listing or Inventory Item.
- This is not an ADR candidate yet. The current shape can likely be expressed as context-local Marketplace and Inventory workflow/docs unless a hard-to-reverse cross-context contract is chosen.
- Standard listing creation should ask Inventory to create or reuse the backing Inventory Item automatically. Marketplace owns the listing workflow and orchestration; Inventory owns stock truth and automatic backing stock behavior.
- Automatic backing Inventory should use an Inventory-owned default `Listing stock` Storage Location. If no default exists, the standard listing flow should collect minimal ship-from details inline, then Inventory creates the default Storage Location and backing Inventory Item.
- Automatic backing Inventory should reuse and adjust one auto-managed `Listing stock` Inventory Item per account/product/selected-options/graded-card/default-location. Inventory should increase auto-managed quantity only as needed for the listing cap and should not silently mutate advanced/manual Inventory Items.
- Automatic backing stock should be created through an Inventory-owned `ensure listing stock` capability/API before Marketplace creates the Listing. Standard Marketplace and Discovery seller routes orchestrate Inventory first, then Marketplace `createListing`.
- Inventory and Import should be removed from primary marketplace top/bottom navigation and exposed through advanced/contextual seller-management links.
- Advanced sellers should still be able to bind a listing to a specific existing Inventory Item from an advanced disclosure area. The standard listing form should be product-first.

## Repo Findings

- Current listing creation blocks on explicit inventory selection:
  - `bounded-contexts/marketplace/routes/account-listings.tsx` loads Inventory items via `createInventoryRequestApiClient` and only prepares a create form when an Inventory Item is selected.
  - `bounded-contexts/marketplace/features/listings/ui/listing-list-page.tsx` shows `View inventory`, `No sellable inventory is available`, an `Inventory item` select, and disables listing actions when no Inventory Item is available.
  - `bounded-contexts/marketplace/features/listings/api/route.ts` requires `inventoryItemId` on `POST /api/marketplace/account/listings`.
  - `bounded-contexts/marketplace/features/listings/api/runtime.ts` requires Marketplace projected supply before `createListing`, then copies Inventory product, location, ship-from, quantity, and cost-derived facts into the listing event.
- Inventory already has a one-way automation precedent for batch imports:
  - `bounded-contexts/inventory/features/import-batches/api/runtime.ts` can create or adjust Inventory Items and then call a `draftListingCreator` host port when import rows include listing price/cap fields.
  - Marketplace handles the draft listing through `createBatchDraftListingFromInventorySnapshot`, including an upsert of the Marketplace supply snapshot before creating the Listing.
- Inventory item creation currently requires a storage location:
  - `bounded-contexts/inventory/features/inventory-items/api/runtime.ts` validates `storageLocationId`, active location status, active catalog item, selected options, and graded-card details.
  - This means standard listing creation needs either an account default listing stock location, an inline minimal ship-from/location step, or a new Inventory-owned automatic location policy.
- Standard sell entry points currently include both Marketplace and Discovery:
  - `/account/listings` accepts `inventoryItemId`, `catalogItemId`, and `recommendedPrice` query params, but it only creates a prefilled form when an existing Inventory Item can be matched.
  - Discovery item detail's Sell tab lists at price through `marketplaceApi.createListing`, but it disables listing unless matching Inventory exists and posts `inventoryItemId`.
- Storage Location is not just UI taxonomy. Inventory's glossary and runtime treat it as the source of ship-from mapping, and listing events/read models carry `shipFromCode` and `shipFromAddress` forward for downstream pricing and fulfillment behavior.
- Design-system progressive-disclosure primitives exist: `Accordion`, `Tabs`, `SegmentedControl`, `NativeSelect`, `NumberInput`, `TextInput`, `Banner`, `MarketplaceDashboardPanel`, and related components.

## Open Questions

### 1. Automatic Backing Inventory Owner

Decision needed: should the standard Marketplace listing flow ask Inventory to create or reuse the backing Inventory Item automatically when a listing is created?

Recommended answer: yes. Keep Listing creation owned by Marketplace, but add an Inventory-owned command/API/host capability for "ensure backing inventory for listing" that creates or reuses an Inventory Item from Marketplace-provided product, quantity, and minimal shipping/storage inputs. Marketplace should never own stock truth, but it can orchestrate the standard seller workflow.

Why it matters: this keeps Inventory as the source of stock truth while removing Inventory Item selection from the standard listing form. It also avoids putting Inventory aggregate behavior inside Marketplace.

Repo evidence: Marketplace already depends on Inventory supply events for Listing capacity, and Inventory already creates draft listings from imports through a host port. The inverse standard-flow orchestration does not exist yet.

Consequence of choosing differently: if Marketplace creates inventory-like records internally, ownership gets muddy and availability/holds diverge. If users must still create Inventory Items first, Inventory remains a standard workflow concern and the requested progressive disclosure is mostly cosmetic.

Answer: yes. Use the recommended split.

### 2. Default Storage And Ship-From For Automatic Backing Inventory

Decision needed: what should the standard listing workflow do when Inventory needs a Storage Location for automatic backing stock?

Recommended answer: create or reuse an Inventory-owned default `Listing stock` Storage Location. If the account has no active default listing location yet, the standard listing flow should ask for the minimum ship-from address inline, then Inventory creates the default location and the backing Inventory Item in the same command/orchestration path. Existing advanced Inventory screens remain available for renaming locations, adding bins, imports, and cost basis.

Why it matters: Inventory requires every Inventory Item to belong to one Storage Location, and every Storage Location maps to one ship-from location. Listing creation cannot safely skip this without weakening shipping and reservation invariants.

Repo evidence: `createInventoryItem` rejects missing/archived storage locations; Storage Location UI currently asks for a full ship-from address; Marketplace Listing events store ship-from snapshots.

Consequence of choosing differently: requiring users to set up Inventory locations first keeps Inventory in the standard workflow. Inferring from account profile may be smoother later, but this repo does not currently show a clear account-level ship-from source of truth in the listing path.

Answer: yes. Use the recommended default `Listing stock` location path.

### 3. Automatic Backing Inventory Quantity Policy

Decision needed: when a standard listing creates or updates backing Inventory, should Inventory reuse/adjust only the auto-managed `Listing stock` item for that product, or should it create a separate Inventory Item per listing?

Recommended answer: reuse one active auto-managed Inventory Item per account, product, selected-options set, graded-card details, and default `Listing stock` location. When the seller creates or increases a listing from the standard flow, Inventory should raise that item's total quantity only as needed to make the requested listing cap available. It should not silently mutate advanced/manual Inventory Items in other locations.

Why it matters: this prevents the standard flow from duplicating stock records while also protecting advanced users who manage exact quantities, locations, and cost basis.

Repo evidence: import commit already searches for an existing item by account, catalog item, product, selected options, and storage location before creating a new Inventory Item. Marketplace already sums active listing caps against Inventory availability.

Consequence of choosing differently: one Inventory Item per listing makes linkage simple but creates noisy duplicate stock for the same product/location. Mutating any matching manual Inventory Item could surprise advanced sellers and corrupt cost/location discipline.

Answer: use the recommended reuse/adjust policy.

### 4. Cross-Context Write Path

Decision needed: should automatic backing stock be created through an explicit Inventory API/capability before Marketplace creates the Listing, or should Marketplace call Inventory internally from its listing runtime?

Recommended answer: add an Inventory-owned `ensure listing stock` capability/API that returns the backing Inventory Item ID plus the supply snapshot Marketplace needs. Standard Marketplace and Discovery seller routes call Inventory first, then call Marketplace `createListing` with the returned `inventoryItemId`. Marketplace may keep its existing supply projection and, if needed for read-after-write, use a narrow snapshot handoff similar to batch imports.

Why it matters: Inventory owns the behavior that creates/adjusts stock; Marketplace owns the Listing event. The route/application workflow can orchestrate both without making Marketplace's aggregate or runtime own Inventory commands.

Repo evidence: current Marketplace account-listings route already composes Marketplace and Inventory request clients. Inventory import currently calls a Marketplace host port in the opposite direction for draft listings, and Marketplace has a snapshot-upsert precedent for listing creation before projections catch up.

Consequence of choosing differently: Marketplace runtime calling Inventory directly makes the Listing service responsible for stock command behavior. Event-only choreography would be purer but likely too slow/indirect for a seller pressing "Create and publish" and expecting immediate feedback.

Answer: use the recommended Inventory API/capability first, then Marketplace Listing creation.

### 5. Inventory Navigation Disclosure

Decision needed: should Inventory and Import leave primary account navigation and become advanced links from listing/seller management surfaces?

Recommended answer: remove `Inventory` and `Import` from top and bottom marketplace navigation. Keep the Inventory routes available for advanced users, but expose them from a secondary/advanced area on Listings and from contextual links such as listing detail or import documentation. The standard nav should emphasize Listings, Offer Matches, Submitted Offers, Purchases/Sales/Shipments, and account settings.

Why it matters: if Inventory remains a primary nav item, users will still perceive it as a prerequisite or peer to Listings. Progressive disclosure should change information architecture, not just form copy.

Repo evidence: `bounded-contexts/inventory/context.json` contributes `Inventory` and `Import` to marketplace-web top and bottom navigation today. Marketplace listing UI also has a prominent `View inventory` action.

Consequence of choosing differently: keeping primary Inventory nav is less disruptive, but it preserves the mental model that sellers must manage stock before listing.

Answer: remove Inventory and Import from primary marketplace navigation.

### 6. Advanced Manual Inventory Binding

Decision needed: should the listing form still allow advanced sellers to bind a listing to a specific existing Inventory Item?

Recommended answer: yes, but only inside an advanced disclosure area. The standard form should be product-first and collect price, quantity, and minimal ship-from only when needed. Advanced controls should include "Use existing inventory", optional explicit Inventory Item selection, purchase limits, and links to Inventory/Import/Locations.

Why it matters: advanced sellers with precise locations, cost basis, imports, and stock discipline should keep control without making first-time or low-volume sellers learn Inventory first.

Repo evidence: current Marketplace and Discovery seller flows already support explicit `inventoryItemId`; Inventory item pages link into listing creation; purchase limits are already optional listing controls and fit advanced disclosure.

Consequence of choosing differently: removing manual binding entirely simplifies the standard model but weakens advanced inventory workflows. Keeping the selector in the main form preserves today's friction.

Answer: yes. Keep manual Inventory Item binding only inside advanced disclosure.

## Implementation Checklist

- [x] Add an Inventory-owned `ensure listing stock` capability/API that:
  - [x] creates/reuses a default auto-managed `Listing stock` Storage Location,
  - [x] collects/uses minimal ship-from details when no default exists,
  - [x] creates/reuses the auto-managed Inventory Item for account/product/selected-options/graded-card/default-location,
  - [x] raises total quantity only as needed to support the requested listing cap,
  - [x] returns the Inventory Item ID and supply snapshot needed for immediate listing creation.
- [x] Update Marketplace account listings route/action to use product-first standard listing creation, call Inventory ensure first, then Marketplace `createListing`/`publishListing`.
- [x] Update Discovery item detail Sell tab to list without requiring pre-existing Inventory and to use the same Inventory ensure then Marketplace listing path.
- [x] Keep explicit Inventory Item selection, purchase limits, and Inventory/Import/Locations links inside an advanced disclosure area.
- [x] Keep Marketplace supply projection and add a narrow read-after-write snapshot handoff before projections catch up.
- [x] Remove Inventory and Import from primary marketplace top/bottom navigation while keeping their routes available from advanced/contextual links.
- [x] Add focused tests for the new standard flow, advanced inventory flow, projection behavior, and failure paths.
- [ ] Verify marketplace desktop and mobile screens visually after implementation.
  - [x] Desktop in-app browser verification: signed in as the seeded demo seller, confirmed standard listing form disclosure, expanded advanced controls, and published a listing without selecting Inventory.
  - [ ] Mobile visual verification remains pending because the current in-app browser session does not expose viewport emulation.
- [ ] Submit a PR, get CI passing, merge the PR, and confirm staging deployment behavior.

## Implementation Evidence

- Inventory now exposes `POST /api/inventory/items/listing-stock/ensure` and request-client/server methods for creating or reusing standard backing stock.
- Automatic backing stock now uses deterministic `inv_listing_stock_*` Inventory Item IDs so the ensure capability does not silently mutate manually managed Inventory Items.
- Marketplace account listing creation now defaults to product-first input and calls Inventory ensure before creating/publishing the Listing.
- Discovery item detail Sell flow no longer requires pre-existing Inventory for standard listing creation.
- Explicit Inventory binding, purchase limits, and Inventory/Import/Locations links are hidden inside advanced disclosure.
- Marketplace listing creation accepts an immediate Inventory snapshot so read-after-write listing creation does not wait on asynchronous projections.
- Inventory and Import are removed from primary marketplace navigation while routes remain available from advanced seller links.
- Durable docs were added at `bounded-contexts/marketplace/docs/standard-listing-inventory-disclosure.md` and `bounded-contexts/inventory/docs/automatic-listing-stock.md`.
- Browser verification published a standard listing from `/account/listings` without selecting an Inventory Item and confirmed the resulting listing used automatic `Listing stock`.

## Documentation To Promote

- Likely Marketplace context doc: standard listing flow and progressive disclosure policy.
- Likely Inventory context doc: automatic backing inventory policy, default storage/location behavior, and advanced inventory surfaces.
- Cross-context glossary update only if new public terms are introduced.
- API docs update if the listing API accepts product/quantity inputs instead of, or in addition to, `inventoryItemId`.
- `docs/README.md` update only if new durable docs are promoted into the curated map.

## Goal Completion Criteria

The later implementation goal must:

- Implement inside this worktree and branch.
- Keep the retained plan at `.codex/plans/20260515-progressive-inventory-disclosure.md`.
- Promote durable docs for any settled Marketplace/Inventory policy.
- Preserve bounded-context ownership: Marketplace owns Listing decisions, Inventory owns stock truth.
- Run relevant automated checks and tests.
- Verify standard listing flow visually on desktop and mobile.
- Submit a PR, get CI passing, merge the PR, and confirm staging deployment behavior.

## Implementation Goal Prompt

Implement progressive inventory disclosure in worktree `D:\Users\ToddS\Source\Repos\chase-sets-20260515-progressive-inventory-disclosure` on branch `codex/progressive-inventory-disclosure` using the retained plan `.codex/plans/20260515-progressive-inventory-disclosure.md`.

Scope:

- Inventory is an advanced feature; standard listing creation must be product-first and automatically backed by Inventory.
- Add an Inventory-owned `ensure listing stock` capability/API for default `Listing stock` location creation/reuse, auto-managed Inventory Item creation/reuse, and quantity adjustment only as needed.
- Marketplace and Discovery seller listing routes should orchestrate Inventory ensure first, then Marketplace listing creation/publish/update.
- Keep explicit Inventory Item binding and purchase-limit controls inside advanced disclosure.
- Remove Inventory/Import from primary marketplace navigation and expose them through advanced/contextual seller-management links.
- Promote durable Marketplace/Inventory docs for the settled policy and update API/docs indexes as needed.

Completion:

- Retain and commit `.codex/plans/20260515-progressive-inventory-disclosure.md`.
- Run relevant automated checks and tests.
- Perform desktop and mobile visual verification of the standard listing flow and advanced disclosure.
- Submit a PR, get CI passing, merge the PR, verify staging deployment behavior, and retain the plan with the implementation.
