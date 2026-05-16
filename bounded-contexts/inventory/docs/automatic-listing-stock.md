# Automatic Listing Stock

Inventory owns the stock truth behind standard Marketplace listings.

Standard sellers do not need to create Inventory Items before listing. Instead, Marketplace asks Inventory to ensure listing stock, and Inventory creates or reuses the private stock records needed to back the Listing.

## Ensure Listing Stock

The Inventory-owned ensure listing stock capability:

- creates or reuses the account's default `Listing stock` Storage Location;
- requires minimal ship-from details when the default location does not exist;
- creates or reuses one auto-managed Inventory Item with a deterministic `inv_listing_stock_*` ID for the account, product, selected options, graded-card details, and default listing stock location;
- increases total quantity only when available quantity is below the requested listing quantity;
- returns the Inventory Item ID and a supply snapshot for immediate Marketplace Listing creation.

## Advanced Inventory

Inventory remains available for sellers who need precise stock operations:

- imports;
- cost basis;
- storage locations;
- manual Inventory Item creation;
- explicit listing-to-inventory binding.

Automatic listing stock must not silently adjust manually managed Inventory Items. The deterministic `inv_listing_stock_*` identity separates automatic stock from advanced/manual stock, even when an advanced seller uses the `Listing stock` location directly.

## Invariants

- Every Inventory Item belongs to one owner account.
- Every Inventory Item belongs to one resolved product and one Storage Location.
- Every Storage Location maps to one ship-from location.
- Availability is derived from total quantity minus active holds.
- Marketplace may reference Inventory availability, but Inventory owns stock truth.
