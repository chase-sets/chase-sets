# Product Alerts

Product Alerts let an account watch one resolved Catalog Product from Discovery product-selection surfaces.

## Ownership

Discovery owns Product Alert behavior because alerts are created from item detail, product selection, and market availability presentation. Catalog owns the source Product identity. Marketplace owns Listing and Offer lifecycle facts that can match an alert.

## Identity

A Product Alert targets:

- `catalog_item_id`
- `product_id`
- normalized `selected_options`
- market side: `listing` or `offer`
- optional price threshold

Listing alerts match active Listings for the selected Product at or below the maximum price. Offer alerts match limited demand signals for submitted Offers at or above the minimum price.

## Notification Policy

Product Alerts send web notifications only in the first implementation. Alerts stay active until paused or deleted.

Each alert notifies at most once for a matched Listing, Offer, or threshold crossing. Replayed Marketplace events must not duplicate notifications.

Offer-side Product Alerts may notify any subscribed account that matching demand exists, but they do not expose buyer identity, shipping details, or full Offer detail unless another Marketplace workflow grants that visibility.
