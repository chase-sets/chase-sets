# Standard Listing Inventory Disclosure

Marketplace owns the standard listing workflow. Inventory remains the source of truth for account-held stock, but standard sellers should not need to create or select Inventory Items before listing a product.

## Policy

- Standard listing creation is product-first: product, price, quantity, and ship-from setup when needed.
- Marketplace orchestrates the seller workflow by asking Inventory to ensure backing listing stock before creating the Listing.
- Marketplace creates the Listing only after Inventory returns a backing Inventory Item ID and supply snapshot.
- Explicit Inventory Item binding is an advanced control, not the default path.
- Inventory and Import are advanced seller-management surfaces reached from contextual listing links, not primary marketplace navigation.

## Standard Flow

1. The seller chooses a product to list from Listings or the Discovery product detail Sell surface.
2. The seller enters price and quantity.
3. If Inventory has no default listing stock location, the form asks for minimal ship-from details.
4. The route asks Inventory to ensure listing stock.
5. Marketplace creates the Listing using the returned Inventory Item ID and snapshot.
6. If the seller chooses "Create and publish", Marketplace publishes the Listing after fee confirmation.

## Advanced Flow

Advanced sellers can open the disclosure controls to:

- bind the Listing to a specific existing Inventory Item;
- set purchase limits;
- manage Inventory, Imports, and Locations directly.

Advanced Inventory control should not be removed. It is just not a prerequisite for the standard workflow.

## Ownership

- Marketplace owns Listing lifecycle, seller pricing, quantity caps, publication, and listing read models.
- Inventory owns Inventory Items, Storage Locations, ship-from mapping, holds, imports, and operational availability.
- Cross-context writes use an Inventory-owned ensure listing stock capability before Marketplace creates a Listing.
