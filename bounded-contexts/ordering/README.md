# Ordering Bounded Context

## Purpose

Ordering owns the commercial commitment between buyer and seller after Checkout asks for orders grouped by seller account.

Cart lines and order lines are product-scoped commitments. Ordering carries the resolved product through checkout and order creation:

- `catalogItemId`
- `productId`
- normalized `selectedOptions`

If an item uses a `condition` dimension, that condition is represented inside the selected dimensions and product summary. Ordering does not persist a separate condition field.

## Owns

- Order creation from listing purchases and accepted offers
- Order lines
- Marketplace sales fee snapshots emitted by listing and offer workflows
- Buyer and seller pairing per order
- Pending-payment and cancelled order status
- Pre-shipment cancellation rules
- Buyer self-service purchase cancellation while Fulfillment has not started packing
- Provider-agnostic tax quote contracts and local deterministic tax quote behavior (`features/tax-quotes`)
- State-by-state tax nexus threshold tracking and collection-provider dependency posture (`features/tax-nexus`)
- Tax readiness language for production marketplace promotion

## Does Not Own

- Listing negotiation
- Payment processor state
- Shipment tracking
- Shipment cancellation execution
- Seller payout accounting
- Tax remittance or filing workflows
- Tax provider adapter selection by deployables

## Ubiquitous Language

Ordering terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Order
- Order Line
- Accepted Offer Commitment Projector

## Incoming Dependencies

- Identity for transaction-party account references
- Marketplace for active product supply and accepted offer decisions
- Inventory reservation outcome events for post-commitment hold execution and release

## Outgoing Integration Events

- `OrderCreated`
- `OrderSplit`
- `OrderCancelled`

## Invariants

1. Checkout owns cart intent and checkout session lifecycle.
2. Ordering consumes Marketplace sales fee snapshots and does not resolve sales fee policy at order time.
3. Checkout lines express buyer intent for a product; concrete listing and inventory matching happen when Ordering creates orders.
4. A checkout session may produce one or more orders grouped by seller account.
5. Inventory holds are placed only when an order is committed and released if the order is cancelled while pending.
6. Buyer self-service cancellation after payment is available only before Fulfillment records packing start.
7. Buyers correct purchase mistakes by cancelling and rebuying, not by editing committed order terms.
8. Tax quotes stay provider-agnostic behind resolver interfaces; orders store immutable tax snapshots after quote resolution.
9. Production marketplace launch may use zero-tax snapshots only while tax readiness evidence confirms no tracked jurisdiction requires collection; provider-backed quotes become required before collecting sales tax in any registered or collecting jurisdiction.

## Tests

Run `pnpm --filter @chase-sets/ordering run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/ordering run test` before opening a PR.

## Tax

Ordering hosts the former Tax bounded context as the `tax-quotes` and `tax-nexus` slices. Order creation requests tax through the injected `taxQuoteResolver` host port and stores the resulting tax snapshot with the order. The slices stay intentionally provider-light so production tax providers can be added without coupling order creation to vendor APIs.

Production launch posture and promotion gates live in [Production Tax Readiness](docs/production-tax-readiness.md), and state-by-state threshold tracking lives in [Tax Nexus Tracking](docs/tax-nexus-tracking.md).

## Open Extraction Candidates

- Tax calculation (`tax-quotes`, `tax-nexus`) can be extracted into a standalone context later if it grows beyond order-term enrichment.
