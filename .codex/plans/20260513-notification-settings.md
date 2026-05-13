# Notification Settings

## Intent

Resolve the confusing split between the `Product Alerts` top-nav destination and the `Notifications` top-nav destination.

The working product direction is:

- `Notifications` should behave like an account-level notification center, opened from the shell as a side sheet or drawer with simple actions.
- Notification preferences should be reachable from that notification surface.
- Product Alert management should be represented inside notification settings rather than as a peer top-nav destination.
- Discovery should keep owning Product Alert behavior unless a later decision creates a dedicated Notifications bounded context that owns cross-context preferences and delivery policy.
- The design system likely needs a canonical notification-center drawer/sheet pattern so application contexts do not invent one-off surfaces.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-notification-settings`
- Branch: `codex/notification-settings`
- Base: current repo `HEAD` from `main` at worktree creation.
- Sandbox id: `aa6cc502`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox doctor: completed.
- Setup caveats: local Node is `v26.1.0`; repo warns it wants Node `24.x`. Existing cyclic workspace dependency warnings remain present.
- Source repo caveat: original worktree has unrelated fulfillment edits in `bounded-contexts/fulfillment/features/shipments/ui/packing-slip-page.tsx` and its test; this planning worktree is clean and does not touch those edits.

## Owning Contexts

Likely owners and responsibilities:

- Discovery owns Product Alert subscriptions, matching, and account Product Alert management behavior.
- Ordering currently owns the `/account/notifications` route and aggregates order, shipment, and product-alert web notification feeds.
- Fulfillment owns shipment notification facts and notification feed routes for shipment events.
- A future Notifications bounded context is already recommended by `docs/architecture/notifications-channel-and-provider-recommendation.md` for policy, consent, channel routing, delivery health, preferences, and notification read models.
- `packages/design-system` owns the canonical drawer/sheet primitives and should own any reusable notification-center pattern.

Important repo evidence:

- `bounded-contexts/discovery/README.md` says Discovery owns Product Alerts created from product detail selection.
- `bounded-contexts/discovery/GLOSSARY.md` defines Product Alert as an account-owned watch on one resolved Catalog Product.
- `bounded-contexts/discovery/docs/product-alerts.md` says Product Alerts send web notifications first and stay active until paused or deleted.
- `bounded-contexts/discovery/context.json` contributes `Product Alerts` to top nav and bottom nav at `/account/product-alerts`.
- `bounded-contexts/ordering/context.json` contributes `Notifications` to top nav and bottom nav at `/account/notifications`.
- `bounded-contexts/ordering/routes/account-notifications.tsx` aggregates order, shipment, and product-alert notification feeds in an Ordering route.
- `packages/design-system/src/components/feedback/dialog.tsx` already exports `Drawer`, and `packages/design-system/src/patterns/app-shells.tsx` already exports `CommerceDrawer`.

## Resolved Decisions

- The current shell model is confusing because Product Alerts and Notifications appear as peer destinations while one is a notification-producing preference/workflow and the other is a cross-context feed.
- Product Alerts should not remain a peer top-nav item if Notifications becomes the user's account notification entry point.
- Ordering should not be the long-term owner of a cross-context notification center, because it does not own Discovery Product Alerts or Fulfillment shipment notifications.
- A design-system update is likely necessary: app contexts should consume a canonical notification drawer/sheet pattern rather than rolling bespoke notification UI.
- The implementation should create a dedicated Notifications bounded context now. Notifications will own the notification center, notification preferences, cross-context feed composition, and delivery-policy surfaces, while source contexts continue to own the facts and behaviors that produce notification intents.
- User-facing language should remain `Product alerts` for Discovery-owned Product Alert rules. The implementation should change placement, not rename the domain concept: `Product alerts` moves out of peer account navigation and into notification settings.
- Notification preferences should manage delivery and notification-center behavior only. Discovery continues to own Product Alert rule behavior: selected product, listing/offer side, threshold, active/paused/deleted lifecycle, and match idempotency.
- The first Notifications bounded-context implementation should own a centralized notification-center read model. Existing per-context `web_notifications` feed ownership should be migrated away from Ordering, Fulfillment, and Discovery toward Notifications-owned feed state and read actions.
- Source contexts should publish durable facts that Notifications consumes. Notifications should not depend on source contexts enqueueing pre-authored notification messages as the long-term handoff. Ordering, Fulfillment, and Discovery keep owning their source facts; Notifications owns notification policy, feed items, read state, preferences, and delivery decisions.
- Product Alert rule management inside notification settings should be compact: the sheet should show delivery/category preferences plus active Product Alert rows with pause, resume, delete, and view-product actions. Creating a Product Alert remains a Discovery item-detail flow.
- Retired full-page routes should redirect to a normal marketplace route carrying notification drawer state in the URL. `/account/notifications` should open the notification drawer; `/account/product-alerts` should open notification settings focused on `Product alerts`. The full-page notification and Product Alert management experiences should not remain canonical surfaces.

## Open Questions

None.

## Implementation Checklist

- [x] Decide notification-center ownership.
- [x] Decide canonical user-facing language for Product Alerts inside notification settings.
- [x] Define the boundary between Product Alert rules owned by Discovery and notification preferences owned by Notifications.
- [x] Decide centralized notification-center read-model ownership.
- [x] Decide cross-context event handoff pattern.
- [x] Decide Product Alert management scope inside notification settings.
- [x] Decide retired full-page route behavior.
- [x] Create the Notifications bounded context with context docs, manifest, package, public surfaces, runtime support, and tests.
- [x] Migrate source contexts to publish facts consumed by Notifications.
  - Ordering and Fulfillment order/shipment domain events are now consumed by Notifications subscriptions. Discovery Product Alert matching remains Discovery-owned because it depends on Product Alert rules and match idempotency, but its web deliveries are dispatched into the Notifications-owned feed.
- [x] Migrate per-context web notification feed state into the Notifications-owned centralized read model.
- [x] Move or retire the full `/account/notifications` page; make the notification center a shell drawer.
- [x] Remove `Product Alerts` as a peer top-nav contribution; keep Product Alerts reachable from item detail and notification settings.
- [x] Add or extend design-system notification drawer/sheet pattern with feed items, unread state, mark-read actions, and settings entry.
- [x] Update account shell composition so the bell opens the notification drawer rather than navigating to a full page.
- [x] Update localization keys, route metadata, and tests around nav labels and notification UI.
- [x] Preserve deep-link access by redirecting retired routes to drawer/settings URL state.
- [x] Verify mobile and desktop visual behavior with the in-app browser after implementation.
  - Verified signed-in desktop feed drawer, signed-in desktop settings drawer, signed-in mobile settings drawer, and retired route redirects on the local marketplace dev stack.

## Documentation To Promote

- Updated `bounded-contexts/discovery/docs/product-alerts.md` with the management-surface decision.
- Added `docs/architecture/notification-center-and-settings.md` for cross-context notification center, settings, route, and design-system decisions.
- Updated `docs/README.md` to include the notification center and settings architecture note.
- Added `bounded-contexts/notifications/README.md`, `GLOSSARY.md`, and `context.json`.
- Updated `bounded-contexts/README.md` for the Notifications bounded context.
- Updated `docs/GLOSSARY.md` with Notifications-owned cross-context terms.
- Consider revising `docs/architecture/notifications-channel-and-provider-recommendation.md` only if the implementation intentionally changes that architectural recommendation.

## Goal Completion Criteria

Implementation goal created for this thread:

- Objective: implement this plan in `D:\Users\ToddS\Source\Repos\chase-sets-20260513-notification-settings` on branch `codex/notification-settings`, retain this plan, promote durable docs, implement and verify the notification center/settings work, submit a draft PR, get CI passing, merge the PR, and verify staging.

The implementation goal should own:

- Work in this worktree and branch.
- Durable docs promotion for any settled ownership and language decisions.
- Product code implementation after planning only.
- Design-system pattern implementation if the drawer/sheet pattern is needed.
- Automated unit/component tests for nav, drawer/feed actions, Product Alert settings access, and context APIs touched.
- Desktop and mobile visual verification for the notification drawer/sheet and settings path.
- Passing local checks appropriate to touched packages.
- Draft PR submission.
- Passing CI.
- PR merge.
- Staging deploy verification.
- Retention of this plan file in the implementation branch.
