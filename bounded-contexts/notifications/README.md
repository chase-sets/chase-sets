# Notifications Bounded Context

## Purpose

Notifications owns account notification delivery policy, notification settings, and the centralized notification-center feed.

## Owns

- Notification Center
- Notification Preference
- Delivery policy and channel preference decisions
- Feed read and unread state
- Notification settings surfaces

## Does Not Own

- Source business facts that may become notifications
- Product Alert rules
- Orders, shipments, listings, offers, payments, or settlement facts
- Provider infrastructure adapters

## Ubiquitous Language

Notifications terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Models

- Notification Center
- Notification Feed Item
- Notification Preference

## Incoming Dependencies

- Source contexts publish durable business facts that Notifications consumes.
- Existing notification contracts define message and delivery primitives.

## Outgoing Integration Events

- `notifications.customer-feedback.delivery-reported`

The delivery report contains only the source workflow reference, channel,
template version, bounded attempt counts, and outcome. Customer comments,
message bodies, contact addresses, and other unnecessary customer data are not
copied into the event.

## Invariants

1. Source contexts publish facts; Notifications decides notification policy and feed presentation.
2. Notification settings manage delivery and notification-center behavior, not source-context business rules.
3. Product Alert rules remain Discovery-owned and appear as a `Product alerts` category inside notification settings.
4. The marketplace notification center is a shell side sheet on desktop and bottom sheet on mobile, not a primary full-page account destination.

## Delivery policy

All durable notification deliveries pass through the shared notification outbox dispatcher in
`infrastructure/notification-outbox`. The dispatcher resolves the recipient account's current
preferences from Notifications and applies them immediately before the channel adapter sends.
This is the only preference-enforcement site; projections and API senders only create notification
messages and enqueue them.

Notification categories use the existing `criticality` as their default:

- `security`, `order-critical`, and `legal` are mandatory and ignore channel opt-outs.
- `operational` is suppressible by channel preference.
- `product-alerts` is suppressible by the Product alerts category preference.

Commerce-critical messages default to `order-critical`; Product Alert intents explicitly override
that default to `product-alerts`. Anonymous messages have no account preference to resolve and are
delivered unless their category is otherwise mandatory.

The audited producer paths are the Notifications source-fact projector, Discovery and Marketplace
notification projectors, Auth session/API senders, and transactional-email projectors in Ordering,
Fulfillment, Payments, Settlement, Platform Operations, and Public Presence. They all enqueue into
the same outbox dispatcher; provider adapters do not send independently.

## Tests

Run `pnpm --filter @chase-sets/notifications run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/notifications run test` before opening a PR.
