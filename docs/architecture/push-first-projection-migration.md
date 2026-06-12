# Push-First Projection Migration Inventory

Status: migration report for #1224 (Milestone #19). Last regenerated: 2026-06-11.

This is the migration report that classifies every projection group and every read-after-write route inventory entry into an explicit push-first disposition. The machine-readable source of truth is `@chase-sets/platform-runtime/projection-push-migration`, which derives every row below from the [source-context wake registry](./source-context-wake-registry.md) (#1245); registry tests pin that registry to `bounded-contexts/*/context.json`, and `projection-push-migration.test.ts` pins this document to the same inventory, so a new projection group or route entry fails CI until both are classified here.

## Classification Model

| Status | Meaning |
| --- | --- |
| `push-enabled` | Every source context the projection consumes from has event-store wake emission and relay fan-out enabled in the registry. Where the loop actually runs is still environment-gated by the kill switches in [Push-Wake Rollout Controls](../runbooks/push-wake-rollout-controls.md) (staging on; production and previews off). |
| `push-eligible` | The projection needs no further migration work; at least one of its source contexts is still waiting on its rollout wave. The `enabled/total` column shows partial wake delivery. |
| `disabled` | Every source context is registry-disabled or registry-opted-out. None today. |
| `opted-out` | The projection group carries an explicit owner-approved opt-out with a reason, review date, and compensating freshness contract. None today. |

Two invariants hold for every row regardless of status:

- **No projection is polling-first by default.** Push eligibility is the default disposition; the platform-worker `projections` runner group keeps polling every projection group only as the reconciliation/fallback layer (the operating invariant in the rollout-controls runbook).
- **Eligibility is not listener rollout state.** A `push-eligible` projection is fully migrated; it is waiting on its source context's wave in the registry, not on projection-side work.

Wake consumption per projection: projections with at least one enabled source receive durable control-plane wake intents (#1246) via the relay; route freshness rides checkpoint-readiness signals and exact read-after-write waits; fallback polling is unconditional for all.

## Opt-Out Policy

An explicit opt-out (`projectionPushOptOuts` in `projection-push-migration.ts`) must carry:

- `owner` — the approving team.
- `reason` — why the projection should not migrate.
- `reviewBy` — ISO expiration/review date; the validator rejects anything unparseable.
- `compensatingFreshnessContract` — the freshness bound that replaces push wakes (for example a documented poll interval).

The validator also rejects opt-outs naming unknown projection groups and duplicates. **Current opt-out count: 0.** Every projection group on the platform is push-first eligible or enabled.

## Projection Groups (58)

Bold source contexts are staging-enabled in the registry (wave 1). `Enabled` counts sources with relay fan-out enabled.

| Projection group | Owner | Source contexts | Status | Enabled |
| --- | --- | --- | --- | --- |
| `auth:auth-identity-account-projection` | Auth | identity | push-eligible | 0/1 |
| `auth:auth-identity-invitation-projection` | Auth | identity | push-eligible | 0/1 |
| `auth:auth-identity-membership-projection` | Auth | identity | push-eligible | 0/1 |
| `auth:auth-identity-user-projection` | Auth | identity | push-eligible | 0/1 |
| `checkout:checkout-catalog-item-projection` | Checkout | catalog | push-eligible | 0/1 |
| `checkout:checkout.cart-projection` | Checkout | **checkout** | push-enabled | 1/1 |
| `checkout:checkout.sell-list-projection` | Checkout | **checkout** | push-enabled | 1/1 |
| `checkout:checkout.session-projection` | Checkout | **checkout** | push-enabled | 1/1 |
| `commercial-terms:commercial-terms-account-projection` | Commercial Terms | identity | push-eligible | 0/1 |
| `discovery:discovery-category-projection` | Discovery | catalog | push-eligible | 0/1 |
| `discovery:discovery-google-shopping-feed-row-projection` | Discovery | catalog | push-eligible | 0/1 |
| `discovery:discovery-item-detail-projection` | Discovery | catalog | push-eligible | 0/1 |
| `discovery:discovery-market-projection` | Discovery | identity, **marketplace** | push-eligible | 1/2 |
| `discovery:discovery-product-alert-notification-projection` | Discovery | **marketplace** | push-enabled | 1/1 |
| `discovery:discovery-product-alert-page-projection` | Discovery | discovery | push-eligible | 0/1 |
| `discovery:discovery-search-item-projection` | Discovery | catalog | push-eligible | 0/1 |
| `fulfillment:fulfillment-account-projection` | Fulfillment | identity | push-eligible | 0/1 |
| `fulfillment:fulfillment-order-source-projection` | Fulfillment | **ordering** | push-enabled | 1/1 |
| `inventory:inventory-catalog-item-projection` | Inventory | catalog | push-eligible | 0/1 |
| `inventory:inventory-hold-projection` | Inventory | inventory | push-eligible | 0/1 |
| `inventory:inventory-item-projection` | Inventory | inventory | push-eligible | 0/1 |
| `inventory:inventory-order-reservation-workflow` | Inventory | **ordering** | push-enabled | 1/1 |
| `inventory:inventory-storage-location-projection` | Inventory | inventory | push-eligible | 0/1 |
| `marketplace:marketplace-catalog-item-projection` | Marketplace | catalog | push-eligible | 0/1 |
| `marketplace:marketplace-identity-account-projection` | Marketplace | identity, **marketplace** | push-eligible | 1/2 |
| `marketplace:marketplace-inventory-supply-projection` | Marketplace | inventory | push-eligible | 0/1 |
| `marketplace:marketplace-listing-projection` | Marketplace | **marketplace** | push-enabled | 1/1 |
| `marketplace:marketplace-offer-projection` | Marketplace | **marketplace** | push-enabled | 1/1 |
| `notifications:notifications-source-facts-outbox-projection` | Notifications | fulfillment, **ordering** | push-eligible | 1/2 |
| `ordering:ordering-account-projection` | Ordering | identity | push-eligible | 0/1 |
| `ordering:ordering-fulfillment-cancellation-inputs` | Ordering | fulfillment | push-eligible | 0/1 |
| `ordering:ordering-inventory-reservation-outcomes` | Ordering | inventory | push-eligible | 0/1 |
| `ordering:ordering-inventory-supply-input-projection` | Ordering | inventory | push-eligible | 0/1 |
| `ordering:ordering-marketplace-offer-acceptance` | Ordering | **marketplace** | push-enabled | 1/1 |
| `ordering:ordering-marketplace-supply-input-projection` | Ordering | **marketplace** | push-enabled | 1/1 |
| `ordering:ordering-payment-capture` | Ordering | **payments** | push-enabled | 1/1 |
| `ordering:ordering-postage-policy-projection` | Ordering | **ordering** | push-enabled | 1/1 |
| `payments:payments-order-cancellation-refund-effect` | Payments | **ordering** | push-enabled | 1/1 |
| `payments:payments-order-input-projection` | Payments | **ordering** | push-enabled | 1/1 |
| `payments:payments-payment-projection` | Payments | **payments** | push-enabled | 1/1 |
| `payments:payments-support-refund-effect` | Payments | support | push-eligible | 0/1 |
| `pricing:pricing-catalog-input-projection` | Pricing | catalog | push-eligible | 0/1 |
| `pricing:pricing-fulfillment-input-projection` | Pricing | fulfillment | push-eligible | 0/1 |
| `pricing:pricing-inventory-input-projection` | Pricing | inventory | push-eligible | 0/1 |
| `pricing:pricing-market-input-projection` | Pricing | **marketplace** | push-enabled | 1/1 |
| `pricing:pricing-order-input-projection` | Pricing | **ordering** | push-enabled | 1/1 |
| `public-presence:public-presence-waitlist-projection` | Public Presence | public-presence | push-eligible | 0/1 |
| `public-presence:public-presence-waitlist-transactional-email-projection` | Public Presence | public-presence | push-eligible | 0/1 |
| `marketplace:reputation-account-projection` | Marketplace | identity | push-eligible | 0/1 |
| `marketplace:reputation-order-source-projection` | Marketplace | **ordering** | push-enabled | 1/1 |
| `marketplace:reputation-shipment-source-projection` | Marketplace | fulfillment | push-eligible | 0/1 |
| `marketplace:reputation-support-source-projection` | Marketplace | platform-operations | push-eligible | 0/1 |
| `settlement:settlement-account-risk-source-projection` | Settlement | identity, **marketplace** | push-eligible | 1/2 |
| `settlement:settlement-fulfillment-source-projection` | Settlement | fulfillment | push-eligible | 0/1 |
| `settlement:settlement-payment-input-projection` | Settlement | **payments** | push-enabled | 1/1 |
| `settlement:settlement-support-hold-projection` | Settlement | platform-operations | push-eligible | 0/1 |
| `platform-operations:support-order-source-projection` | Platform Operations | **ordering** | push-enabled | 1/1 |
| `platform-operations:support-shipment-source-projection` | Platform Operations | fulfillment | push-eligible | 0/1 |

Totals: 20 `push-enabled`, 38 `push-eligible`, 0 `disabled`, 0 `opted-out`.

## Read-After-Write Route Inventory (18)

Every route inventory entry keeps its exact durable wait or carries an owner-approved exception recorded in the owning context's `context.json` (validated by #1233). "Wave posture" describes whether commits behind the route's freshness dependencies currently emit push wakes in staging; exact waits and recovery contracts hold in every posture.

| Route entry | Owning context | Risk | Freshness contract | Wave posture (staging) |
| --- | --- | --- | --- | --- |
| `checkout.cart-self-refresh` | checkout | important | accepted exception (checkout, review 2026-07-31, #1084/#1083) | push-accelerated |
| `checkout.guest-sell-list-to-checkout` | checkout | important | accepted exception (checkout, review 2026-07-31) | push-accelerated |
| `checkout.sell-list-self-refresh` | checkout | important | accepted exception (checkout, review 2026-07-31, #1084/#1083) | push-accelerated |
| `checkout.session-offer-handoff` | checkout | important | accepted exception (checkout, review 2026-07-31; destination owned by Marketplace) | push-accelerated |
| `checkout.session-payment-handoff` | checkout | critical | accepted exception (checkout, review 2026-07-31; destination owned by `payments.create-to-detail`) | push-accelerated |
| `checkout.session-self-refresh` | checkout | critical | exact wait | push-accelerated |
| `checkout.session-start-to-detail` | checkout | critical | exact wait | push-accelerated |
| `discovery.item-detail-checkout-handoff` | discovery | important | not-post-write-read (discovery, review 2026-07-31; destination Checkout-owned) | poll-bounded until wave 3 |
| `identity.shipping-addresses-self-refresh` | identity | important | not-read-model-backed (identity, review 2026-07-31) | poll-bounded until wave 2 |
| `inventory.import-batch-detail` | inventory | important | accepted exception (inventory, review 2026-07-31; job-backed) | poll-bounded until wave 2 |
| `inventory.item-adjust-to-detail` | inventory | critical | exact wait | poll-bounded until wave 2 |
| `marketplace.listing-create-to-detail` | marketplace | critical | exact wait | push-accelerated |
| `marketplace.listing-list-self-refresh` | marketplace | important | accepted exception (marketplace, review 2026-07-31, #1084) | push-accelerated |
| `marketplace.submitted-offer-detail` | marketplace | important | exact wait | push-accelerated |
| `payments.create-to-detail` | payments | critical | exact wait | push-accelerated |
| `payments.detail-self-refresh` | payments | important | exact wait | push-accelerated |
| `reputation.review-submit-to-detail` | marketplace | important | accepted exception (marketplace, review 2026-07-31, #1084) | push-accelerated |
| `settlement.payout-request-to-detail` | settlement | important | accepted exception (settlement, review 2026-07-31, #1084) | poll-bounded until wave 3 |

## Rollout Waves: Staging First, Production Gated

Wave membership lives in the registry; this report records the enablement timeline #1224 requires:

- **Wave 1 (`checkout`, `marketplace`, `ordering`, `payments`)** — staging-enabled. `checkout` since 2026-06-10 (push-loop evidence in [Push-Wake SLO And Load Proof](./push-wake-slo-load-proof.md)); the wave-1 remainder enabled 2026-06-11 on the back of that evidence. The wave-1 listener URLs and the connection budget in `infrastructure/digitalocean/platform/locals.tf` already cover all four contexts in both staging and the production worst case, so these flips change no Terraform.
- **Production follow** — production stays inert (`PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED=false`, `WORKER_PROJECTION_WAKE_RELAY_ENABLED=false`, `READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED=false`) until the production gates pass: a green steady-state production proof canary per the #1237 miss analysis and hold-then-gate action set in the SLO/load-proof doc, plus #1243 topology parity evidence. Flipping is a deliberate operator decision via the [rollout-controls runbook](../runbooks/push-wake-rollout-controls.md), not a registry side effect.
- **Wave 2 (`catalog`, `fulfillment`, `identity`, `inventory`)** — eligible, not staging-enabled. Blocked on the listener/connection-budget expansion decision: `worker_listener_source_contexts` budgets exactly the four wave-1 listeners, and high-volume contexts (catalog, identity, inventory) additionally need the wake-store capacity evidence (#1246 gates in the registry doc) before enablement.
- **Wave 3 (`discovery`, `public-presence`, `settlement`, `support`)** — eligible, follows wave 2 with owner approval.
- **Wave 4 (`auth`, `commercial-terms`, `experience`, `insights`, `notifications`, `platform-operations`, `pricing`, `tax`)** — no source-projection fan-out or route dependency requiring event-store wakes; these contexts emit nothing today and need no opt-out because nothing consumes from them.

## Documented Polling Exceptions

Polling that remains by design, not as a migration gap:

- **Fallback/reconciliation polling** — the worker `projections` runner group polls every projection group as the durable correctness layer under every kill-switch posture. This is the operating invariant, not a migration hold-over.
- **Provider outbox dispatchers** (transactional email, notification delivery) — scheduled/poll dispatchers over durable outbox rows; excluded from push-first SLO gates as a documented exception in the SLO/load-proof doc and the composite origin inventory.
- **Preview environments** — define no listener URLs; the relay falls back to catch-up-only behavior by design.

## Operator Visibility

- `GET /api/platform/projections/wake-status` exposes the structural inventory live: migration status by projection group (owner, status, enabled/total sources, opt-out reason) alongside rollout state by source context. The Admin Push wakes handoff links operators to Grafana/runbooks and current attention items; it must not re-render the full telemetry inventory.
- `GET /api/platform/projections/wake-status` exposes the same data structurally under `migration` for dashboards.
- The worker status endpoint reports the loaded projection interest index summary, which carries the same owner/opt-out data into the relay's fan-out decisions (see [Projection Interest Index](./projection-interest-index.md)).
