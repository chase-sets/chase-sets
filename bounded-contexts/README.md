# Chase Sets Bounded Context Map

This directory defines the strategic bounded context map for Chase Sets.

Each bounded context owns its own terms, state transitions, internal models, read models, UI, and tests. Cross-context interaction must happen through stable IDs and published integration events.

Structure, public export, deployable composition, and shared-ID rules live in [Bounded Context Structure](../docs/architecture/bounded-context-structure.md).

Each context `README.md` follows a common shape — see [Fulfillment](./fulfillment/README.md) as the reference: Purpose, Owns, Does Not Own, Ubiquitous Language (link to `GLOSSARY.md`), Core Aggregates and Process Managers, Incoming Dependencies, Outgoing Integration Events, and Invariants.

## Contexts

| Context | Purpose |
| --- | --- |
| [Auth](./auth/README.md) | Own sign-in, sign-out, registration, session lifecycle, and session-entry journeys. |
| [Identity](./identity/README.md) | Own users, accounts, memberships, invitations, API keys, consents, and identity-management surfaces. |
| [Catalog](./catalog/README.md) | Own the canonical product model for what can be bought or sold. |
| [Public Presence](./public-presence/README.md) | Own public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review. |
| [Discovery](./discovery/README.md) | Own browse, search, and detail discovery experiences for catalog items. |
| [Checkout](./checkout/README.md) | Own account cart intent and active checkout session orchestration. |
| [Inventory](./inventory/README.md) | Own account-held stock and operational availability. |
| [Commercial Terms](./commercial-terms/README.md) | Own seller-side marketplace sales fee policy and account-specific commercial agreements. |
| [Marketplace](./marketplace/README.md) | Own listing and offer workflows before an order exists, plus post-transaction reviews and review summaries. |
| [Ordering](./ordering/README.md) | Own per-seller orders, commercial commitment, provider-agnostic tax quotes, and tax nexus readiness. |
| [Fulfillment](./fulfillment/README.md) | Own shipment execution and delivery state. |
| [Notifications](./notifications/README.md) | Own account notification center, notification settings, feed read state, and delivery policy. |
| [Payments](./payments/README.md) | Own external money movement, charges, and refunds. |
| [Settlement](./settlement/README.md) | Own internal ledger truth, balances, and payouts. |
| [Pricing](./pricing/README.md) | Own fair-value estimation and repricing intelligence. |
| [Platform Operations](./platform-operations/README.md) | Own operator workflows for platform runtime health, release controls, cross-context insights reporting, platform feedback, and marketplace support requests. |

Implemented contexts are the directories that contain both `package.json` and `context.json`.

## Planned Contexts

A planned context reserves ownership and vocabulary before any code exists. It has no directory, no `package.json`, and no `context.json`, and nothing in this repository implements it yet. It is listed separately from the map above and must not be treated as an implemented context.

- **Scanning** (planned) will own Card Scan and Scan Session lifecycle, provider-neutral identification orchestration, seller match confirmation and correction, and the Unidentified Scan queue for camera-based seller intake. Provider identification output is advisory evidence; only an explicit seller-confirmed complete Catalog Product selection is authoritative, and provider vocabulary stays behind a provider port with an anti-corruption mapping. Boundaries: Catalog keeps canonical Product identity, the valid set of selected Options, and reusable provider references and mappings; Inventory keeps Import review, Product validation, and stock — including Import Batch creation, quantity validation, and stock quantity truth — which Scanning may later feed with a confirmed fact carrying scan-count evidence but never bypasses or writes directly; Discovery keeps Relevance, the advisory ranking it expresses as ordered Result Sets, and owns no seller Product-resolution behavior; Marketplace keeps Listing creation. Scanning reuses those owners' surfaces instead of building a second Product chooser or a second ranker, and condition, price, and listing-draft fields stay seller-declared. Recorded in [ADR 0031: Card Identification Authority And Provider Boundary](../docs/adr/0031-card-identification-authority-and-provider-boundary.md); the planned term family is registered in the [Marketplace Glossary](../docs/GLOSSARY.md).

## Ownership Rules

1. A business concept has exactly one owning bounded context.
2. Contexts may reference each other only by stable IDs and published integration events.
3. Contexts must not import another context's internal aggregate state or reuse internal types directly.
4. Shared contracts are limited to primitives, typed IDs, and integration-event schemas.
5. Discovery may project browse-oriented read models from upstream contexts without taking ownership of the underlying transactional truth.

Settings follow the same single-owner rule: behavior-coupled settings stay with the context that owns the behavior, viewer presentation preferences live on the User in Identity, and device ephemera stay client-local. See [Settings Ownership](../docs/architecture/settings-ownership.md).

## Canonical Ownership

These marketplace nouns are already fixed to a single owner:

- Account is the root identity for marketplace participation.
- Buyer and Seller are transaction roles played by an Account, not separate root entities or capability classes.
- Listing is owned by Marketplace.
- Offer is owned by Marketplace.
- Cart is owned by Checkout.
- Checkout Session is owned by Checkout.
- Order is owned by Ordering.
- Shipment is owned by Fulfillment.
- Review is owned by Marketplace through its reviews slice.

Use Buyer and Seller when describing transaction endpoints: the buyer account pays and receives products; the seller account provides products and receives settlement.

## Upstream and Downstream Relationships

- Auth is upstream for browser authentication journeys and actor-resolution helpers, while Identity facts are projected into Auth for local reads.
- Identity is upstream for user and account references.
- Public Presence owns public product and waitlist surfaces; admin review composition may depend on Auth and Identity.
- Catalog is upstream for canonical item references.
- Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views.
- Inventory depends on Identity and Catalog product structure.
- Commercial Terms depends on Identity account references and account classification facts.
- Marketplace depends on Identity, Auth journey entry points, Catalog product identity, Inventory availability signals, and Commercial Terms sales fee resolutions.
- Marketplace is downstream of Discovery for browse entry points but remains the owner of listing and offer decisions.
- Checkout depends on Discovery entry points, Catalog product identity, Ordering order creation, and Payments payment initialization.
- Ordering depends on Marketplace product commitments and seller-confirmed fee snapshots, Identity account references, and inventory reservation outcomes published after order commitment.
- Fulfillment depends on Ordering.
- Marketplace reviews depend on Identity for account references, Ordering for order references, and Fulfillment for delivery outcomes.
- Notifications depends on source-context facts from Discovery, Ordering, Fulfillment, and future contexts for account-visible notification decisions.
- Payments depends on Ordering and on refund triggers informed by Fulfillment outcomes.
- Settlement depends on Payments and Ordering.
- Pricing consumes history from Catalog, Inventory, Marketplace, Ordering, and Fulfillment.
- Platform Operations consumes integration events from transactional contexts for read-only insights reporting.

## Integration Rule

Integration events must publish facts, not commands.

Each context may define rich internal domain events, but only a small, stable integration-event surface should be shared downstream.

## Scenario Ownership Checks

These scenarios should map cleanly to one owner per decision:

1. Inventory owns bulk stock ingestion and account-held stock for a resolved product.
2. Commercial Terms owns seller-side marketplace sales fee schedules, negotiated overrides, and deterministic fee resolutions.
3. Marketplace owns listing publication and offer negotiation for products.
4. Checkout owns cart intent and checkout sessions; Ordering owns order creation for committed products.
5. Fulfillment owns shipment state and tracking.
6. Marketplace owns post-transaction ratings, written feedback, and aggregate review summaries through its reviews slice.
7. Payments owns charge and refund execution.
8. Settlement owns ledger adjustments and payout eligibility.
9. Ordering owns tax quote contracts and order tax snapshots through its tax-quotes slice.
10. Pricing owns recommendations but never directly mutates listings or inventory.
11. Platform Operations owns insights reporting and forecasting without owning source transactions.
