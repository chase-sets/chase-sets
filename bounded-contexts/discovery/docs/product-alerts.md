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

## Management Surface

Discovery owns Product Alert rules, but Product Alerts should not be a peer account-navigation destination beside Notifications.

Notification settings are the account-level home for Product Alert delivery controls and compact rule management. The settings surface may show active Product Alert rows with pause, resume, delete, and view-product actions. Creating a Product Alert remains a Discovery item-detail flow because product selection, resolved options, and market-side intent are Discovery-owned behavior.

The Notifications bounded context owns the notification center, notification preferences, feed read state, and delivery-policy decisions. Discovery should publish Product Alert match facts for Notifications to consume rather than directly owning the cross-context notification center.
