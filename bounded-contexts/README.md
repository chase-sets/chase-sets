# Chase Sets Bounded Context Map

This directory defines the strategic bounded context map for Chase Sets.

The goal is to keep ownership, language, and invariants explicit before implementation packages are created. Each bounded context owns its own terms, state transitions, and internal models. Cross-context interaction must happen through typed IDs and published integration events.

## Contexts

| Context | Purpose |
| --- | --- |
| [Auth](./auth/README.md) | Own sign-in, sign-out, registration, and session-entry journeys. |
| [Identity](./identity/README.md) | Own users and the accounts they act for. |
| [Catalog](./catalog/README.md) | Own the canonical product model for what can be bought or sold. |
| [Discovery](./discovery/README.md) | Own browse, search, and detail discovery experiences for catalog items. |
| [Inventory](./inventory/README.md) | Own seller-held stock and operational availability. |
| [Marketplace](./marketplace/README.md) | Own listing and offer workflows before an order exists. |
| [Ordering](./ordering/README.md) | Own checkout normalization and commercial commitment. |
| [Fulfillment](./fulfillment/README.md) | Own shipment execution and delivery state. |
| [Reputation](./reputation/README.md) | Own post-transaction ratings, written feedback, and canonical reputation summaries. |
| [Payments](./payments/README.md) | Own external money movement and buyer-facing charges or refunds. |
| [Settlement](./settlement/README.md) | Own internal ledger truth, balances, and payouts. |
| [Pricing](./pricing/README.md) | Own fair-value estimation and repricing intelligence. |
| [Insights](./insights/README.md) | Own cross-context reporting, analytics, and forecasting views. |

## Ownership Rules

The following rules apply to every context in this directory:

1. A business concept has exactly one owning bounded context.
2. Contexts may reference each other only by stable IDs and published integration events.
3. Contexts must not import another context's internal aggregate state or reuse internal types directly.
4. Shared contracts are limited to primitives, typed IDs, and integration-event schemas.
5. Discovery may project browse-oriented read models from upstream contexts without taking ownership of the underlying transactional truth.

## Data Ownership And Structure

Each implemented bounded context is the canonical home for its own:

- data model
- schema composition
- projections and read models
- persistence orchestration
- seeds and test support

Shared top-level `infrastructure/` is reserved for reusable technical adapters only.

Examples of shared infrastructure:

- a Postgres pool factory
- a generic event-store adapter
- a projection checkpoint adapter
- a shared queue or search client

Examples of bounded-context-owned data plumbing:

- context schema assembly
- projector fanout
- read-model queries
- projection table naming
- seed orchestration

Inside a bounded context, avoid generic folder names such as `infrastructure`, `shared`, and `support`.

Prefer:

- slice-local files when behavior belongs to one slice
- purpose-specific names such as `projection-support`, `shell-support`, `seed-support`, `read-models`, `projections`, `persistence`, or `integration` when context-local code is reused across slices

## Canonical Ownership

These marketplace nouns are already fixed to a single owner:

- Buyer and Seller are roles played by an Account, not separate root entities.
- Listing is owned by Marketplace.
- Offer is owned by Marketplace.
- Order is owned by Ordering.
- Shipment is owned by Fulfillment.
- Review is owned by Reputation.

## Shared Typed IDs

Cross-context references should use the canonical IDs defined in shared contracts or the owning bounded context.

Shared IDs in [`contracts/primitives/typed-ids.ts`](../contracts/primitives/typed-ids.ts):

- `AccountId`
- `UserId`
- `InventoryRecordId`
- `ListingId`
- `OfferId`
- `OrderId`
- `ShipmentId`
- `ReviewId`
- `PaymentId`
- `LedgerEntryId`
- `PayoutId`

Catalog-owned IDs in [`catalog/ids.ts`](./catalog/ids.ts):

- `CatalogItemId`

## Upstream and Downstream Relationships

- Auth is upstream for browser authentication journeys and actor-resolution helpers.
- Identity is upstream for user and account references.
- Catalog is upstream for canonical item references.
- Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views.
- Inventory depends on Identity and Catalog sellable-unit structure.
- Marketplace depends on Identity, Auth journey entry points, Catalog sellable-unit identity, and Inventory availability signals.
- Marketplace is downstream of Discovery for browse entry points but remains the owner of listing and offer decisions.
- Ordering depends on Marketplace sellable-unit commitments and Identity account references.
- Fulfillment depends on Ordering.
- Reputation depends on Identity for account references, Ordering for order references, and Fulfillment for delivery outcomes.
- Payments depends on Ordering and on refund triggers informed by Fulfillment outcomes.
- Settlement depends on Payments and Ordering.
- Pricing consumes history from Catalog, Inventory, Marketplace, Ordering, and Fulfillment.
- Insights consumes integration events from every context.

## Integration Rule

Integration events must publish facts, not commands.

Each context may define rich internal domain events, but only a small, stable integration-event surface should be shared downstream.

## Scenario Ownership Checks

These scenarios should map cleanly to one owner per decision:

1. Inventory owns bulk stock ingestion and seller stock for a resolved sellable unit.
2. Marketplace owns listing publication and offer negotiation for sellable units.
3. Ordering owns cart decomposition and order creation for committed sellable units.
4. Fulfillment owns shipment state and tracking.
5. Reputation owns post-transaction ratings, written feedback, and aggregate reputation summaries.
6. Payments owns charge and refund execution.
7. Settlement owns ledger adjustments and payout eligibility.
8. Pricing owns recommendations but never directly mutates listings or inventory.
9. Insights owns reporting and forecasting without owning source transactions.
