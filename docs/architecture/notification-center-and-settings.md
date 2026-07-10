# Notification Center And Settings

## Scope

This doc owns the Notification Center UI, notification feed composition, read/unread state, and settings surface. Provider selection, channel strategy (email/SMS/RCS/web/push), and cost controls live in [Notifications Channel And Provider Recommendation](./notifications-channel-and-provider-recommendation.md).

## Decision

Notifications should be a dedicated bounded context that owns the account notification center, notification settings, centralized feed read model, read/unread state, and delivery-policy decisions.

The marketplace shell should expose Notifications as a bell-triggered side sheet on desktop and a bottom sheet on mobile, not as a primary full-page account destination. The sheet should support simple notification actions, mark-read behavior, and a settings view.

Product Alerts should remain the canonical Discovery term for account-owned watches on resolved Catalog Products. They should move out of primary account navigation and appear as `Product alerts` inside notification settings.

## Ownership

Notifications owns:

- notification center feed composition
- centralized notification read model
- read and unread state
- notification settings and channel preferences
- shell notification side sheet contribution and settings surface

Delivery policy, channel eligibility, suppression, and provider selection are also decided by the Notifications bounded context, but the recommendation and rationale for those decisions live in [Notifications Channel And Provider Recommendation](./notifications-channel-and-provider-recommendation.md), not here.

Source contexts own the facts that may lead to notifications:

- Discovery owns Product Alert rules and Product Alert match facts.
- Ordering owns order and purchase facts.
- Fulfillment owns shipment facts.
- Future contexts own their own source facts.

Source contexts should publish durable facts that Notifications consumes. They should not be the long-term owners of account notification feed rows, read actions, or channel policy.

## Product Alerts

Notification settings may provide compact Product Alert management:

- delivery/category preferences
- active Product Alert rows
- pause, resume, delete, and view-product actions

Creating a Product Alert remains a Discovery item-detail workflow because Discovery owns product selection, resolved options, market side, and price-threshold rules.

## Routes And Shell

The notification bell should open the notification side sheet or bottom sheet. Retired full-page routes should redirect to a normal marketplace route carrying sheet state in the URL rather than preserving separate full-page notification experiences.

Recommended compatibility behavior:

- `/account/notifications` redirects to a route that opens the notification sheet.
- `/account/product-alerts` redirects to a route that opens notification settings focused on `Product alerts`.
- Primary account navigation removes `Product Alerts` as a peer destination beside `Notifications`.

## Design System

The design system should provide the canonical notification-center side-sheet and bottom-sheet pattern. Application contexts should consume that pattern instead of inventing custom notification panels.

The pattern should cover:

- feed item layout
- unread indicator
- mark-one-read and mark-all-read actions
- action links
- empty state
- settings entry
- compact settings sections
- mobile and desktop responsive behavior
