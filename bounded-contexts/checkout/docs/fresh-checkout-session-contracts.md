# Fresh Checkout Session Contracts

Milestone #17 uses this contract shape for Shopify-simple buy and sell checkout. It is a fresh pre-launch contract, not an adapter for dense checkout session payloads.

## Contract Owner

Checkout owns the fresh checkout session snapshot because Checkout owns cart intent, Sell List intent, checkout session lifecycle, selected shipping, and checkout review state. Other contexts supply stable facts only:

- Identity supplies account and saved-info facts.
- Fulfillment supplies readiness, delivery promise, label, and serviceability facts.
- Ordering supplies order handoff facts after buy confirmation.
- Payments supplies payment method, provider, wallet/credit, and payment handoff facts.
- Settlement supplies payout readiness, payout method, seller net, and payout handoff facts.
- Tax supplies provider-agnostic tax quote status and amount.
- Marketplace supplies listing and offer facts before order or sale commitment.
- Notifications supplies communication state after confirmation.

## Snapshot Shape

Every fresh checkout session snapshot uses `schemaVersion: checkout.fresh-session.v1` and a shared renderable shape:

- `creationIdempotencyKey`
- `mode`: `buy` or `sell`
- `actorMode`: `guest` or `signed-in`
- `guestMerge`: whether a guest snapshot can merge into a signed-in account without recreating checkout
- `lifecycleStatus`: `draft`, `ready`, `confirming`, `confirmed`, `failed`, or `recovering`
- `source`: `cart`, `buy-now`, or `sell-list`
- `lines`: customer-safe item/list summary rows
- `contact`: email, phone, and display-name validation state
- `deliveryAddress` or `shipFromAddress`
- `shipping`
- `readiness`: fulfillment or seller readiness status plus unresolved line IDs
- `freshness`: current, stale, or refreshing state
- `provider`: support-safe provider status and correlation
- `risk`: clear, held, or blocked state
- `recovery`: stale, provider-failure, partial-completion, invalid-address, unresolved-fulfillment, seller-readiness, or risk-review recovery state
- `communication`
- `reconciliation`
- `postConfirmation`
- `savedInfoRows`
- `availableCommands`

Buy sessions add:

- `payment`
- `cartReadinessSnapshot`: the Checkout-owned cart readiness snapshot consumed when a cart checkout session starts
- `totals.subtotal`
- `totals.shipping`
- `totals.tax`
- `totals.fees`
- `totals.discounts`
- `totals.credits`
- `totals.payableTotal`

Sell sessions add:

- `payout`
- `totals.estimatedPayout`
- `totals.labelOrShippingAllowance`
- `totals.fees`
- `totals.adjustments`
- `totals.payoutTotal`
- `totals.verificationTermsAccepted`

## Fresh Commands

Fresh checkout supports only explicit new-flow commands:

- `update-contact`
- `update-address`
- `select-shipping-method`
- `select-payment-method`
- `select-payout-method`
- `apply-credit-or-promotion`
- `remove-credit-or-promotion`
- `refresh-totals`
- `confirm`
- `recover-stale-session`
- `recover-provider-failure`
- `recover-partial-completion`
- `merge-guest-session`
- `return-to-source-list`

The contract intentionally forbids old-session commands such as `start-legacy-checkout`, `load-dense-checkout-session`, `adapt-old-checkout-payload`, and `dual-write-legacy-session`.

## State Machine

Fresh sessions use a single lifecycle state machine:

- `draft` can move to `ready`, `failed`, or `recovering`
- `ready` can move to `confirming`, `recovering`, or `failed`
- `confirming` can move to `confirmed`, `recovering`, or `failed`
- `confirmed` is terminal
- `failed` can move to `recovering`
- `recovering` can move to `ready` or `failed`

This gives deploy skew, stale totals, provider failure, and partial completion one customer-safe recovery path instead of preserving old checkout payloads.

## Confirmability Rules

A session can confirm only when:

- `lifecycleStatus` is `ready`
- readiness is `ready`
- no line has unresolved fulfillment
- freshness is `current`
- provider status is `ready`
- risk status is `clear`
- buy sessions have valid contact, delivery address, and payment
- sell sessions have valid ship-from address, payout method, and payout readiness

Unresolved fulfillment stays in Buy Cart, Sell List, or the conditional readiness step. It does not enter the main checkout form.

## Buy Cart Readiness Snapshot

Cart checkout entry uses a Checkout-owned readiness snapshot with `schemaVersion: checkout.cart-readiness.v1`.
The snapshot is produced from the current Buy Cart, records the source revision, included checkout line IDs,
unresolved line IDs, customer-safe line outcomes, and optional fulfillment optimization decision. Checkout
session creation recomputes the snapshot from current cart facts and rejects missing, stale, partial, blocked, or
unresolved readiness input.

Supported customer-safe outcomes before checkout are:

- ready lines continue into checkout;
- unavailable or waiting-for-supply lines are removed or kept in the cart outside checkout;
- a proposed lower-cost fulfillment option is accepted and applied to the checkout lines;
- a proposed lower-cost fulfillment option is declined while the current allocation remains valid.

The checkout form may display the resulting delivery/summary facts, but it must not regroup sellers, assign
fulfillment, or ask the buyer to resolve unavailable items inside checkout.

Changed economics are represented by `freshness.reason` values such as `shipping-changed`, `tax-changed`, `fees-changed`, `discounts-changed`, or `credits-changed`. The customer must refresh and review the updated total before confirmation.

Address problems are represented as validation and recovery state. Invalid or restricted addresses cannot confirm.

## Sell List Readiness Snapshot

Seller checkout review uses a Checkout-owned readiness snapshot with `schemaVersion: checkout.sell-list-readiness.v1`.
The snapshot is produced from the current Sell List, records the source revision, included checkout line IDs,
unresolved line IDs, customer-safe line outcomes, and the pre-checkout sale action chosen for each included line.
Checkout recomputes the snapshot from current Sell List facts and rejects missing, stale, partial, blocked, or
unresolved readiness input.

Supported customer-safe outcomes before seller checkout are:

- selected offer lines with current offer facts continue into seller checkout review;
- product-level lines continue only when the pre-checkout review chooses a Smart Match offer or fallback listing action;
- unresolved product-level lines stay in the Sell List outside checkout;
- intentionally removed lines are excluded before seller checkout begins.

The seller checkout form may display concise payout, listing, label, and next-step summary facts, but it must not
silently choose sale actions, manufacture payout readiness, repair missing ship-from/label facts, or absorb provider
diagnostics that belong in Sell List readiness or later provider-owned setup flows.

## Idempotency And Guest Merge

Fresh session creation is idempotent by `creationIdempotencyKey`, which is derived from the source intent and the current checkout-relevant revision. Replaying creation for the same cart, buy-now, or Sell List state must return the same active session or replace it with a fresh regenerated session, not create duplicate customer commitments.

Guest checkout uses `actorMode: guest`, `accountId: null`, and `guestMerge`. When a guest signs in before or during checkout, the merge command attaches the fresh session to the signed-in account if `guestMerge.eligible` is true. It does not adapt old checkout state, recover old URLs, or dual-write old payloads.

## Customer Copy Rules

Fresh snapshots are allowed to expose customer-safe item titles, subtitles, delivery promises, saved-info rows, recovery messages, and provider status messages. They must not expose implementation language such as projections, read models, allocations, provider payloads, internal processing, dual writes, or legacy checkout.

## Sensitive Data Rules

Fresh snapshots must not contain raw provider payloads, client secrets, card numbers, CVC/CVV values, bank account numbers, routing numbers, tax IDs, provider identity payloads, or uploaded verification documents.

Provider, payment, payout, tax, and identity state must be support-safe:

- provider status
- display labels
- masked external references
- retry availability
- customer-safe recovery messages
- stable correlation IDs

## Compatibility Rules

This product has not launched, so there is no old checkout payload compatibility requirement. The fresh contract does not support:

- old checkout URL recovery as a customer path
- dense checkout session payload adapters
- old/new dual writes
- migration backfills for abandoned pre-launch sessions
- customer-facing compatibility toggles

Legacy state can be reset or regenerated through #1132 as implementation replaces the old session model.

## Test Expectations

Contract tests must prove:

- buy and sell snapshots render from one shared summary shape
- buy totals and sell payout totals stay mode-specific
- unresolved fulfillment requires pre-checkout resolution
- stale sessions, provider failures, seller readiness failure, and risk holds cannot confirm
- invalid addresses and changed economics cannot confirm until recovered
- deploy skew and partial completion recover through fresh commands only
- lifecycle transitions follow the fresh state machine
- creation idempotency and guest merge are explicit
- notification, reconciliation, and post-confirmation states are represented without side effects
- customer-facing copy avoids internal implementation language
- sensitive-data keys are rejected
- old-session commands are forbidden fresh commands
