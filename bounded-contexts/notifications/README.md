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

- None in the first extraction.

## Invariants

1. Source contexts publish facts; Notifications decides notification policy and feed presentation.
2. Notification settings manage delivery and notification-center behavior, not source-context business rules.
3. Product Alert rules remain Discovery-owned and appear as a `Product alerts` category inside notification settings.
4. The marketplace notification center is a shell side sheet on desktop and bottom sheet on mobile, not a primary full-page account destination.

## Tests

Run `pnpm --filter @chase-sets/notifications run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/notifications run test` before opening a PR.
