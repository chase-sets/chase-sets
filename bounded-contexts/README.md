# Chase Sets Bounded Context Map

This directory defines the strategic bounded context map for Chase Sets.

The goal is to keep ownership, language, and invariants explicit before implementation packages are created. Each bounded context owns its own terms, state transitions, and internal models. Cross-context interaction must happen through typed IDs and published integration events.

## Contexts

| Context | Purpose |
| --- | --- |
| [Auth](./auth/README.md) | Own sign-in, sign-out, registration, session lifecycle, and session-entry journeys. |
| [Identity](./identity/README.md) | Own users, accounts, memberships, invitations, API keys, consents, and identity-management surfaces. |
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

Implemented contexts are the directories that contain both `package.json` and `context.json`.

Documentation-only future contexts may still have a README and glossary, but they do not participate in runtime structure checks until they become implemented workspace packages.

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
- purpose-specific names such as `route-support`, `request-support`, `projection-support`, `shell-support`, `seed-support`, `read-models`, `projections`, or `persistence` when context-local code is reused across slices

## Feature-Default Directory Plan

Bounded contexts should read as **feature-first** by default.

Top-level directory intent:

- `slices` entries in `context.json` are the default and must be feature slices.
- Any non-feature top-level directory is an explicit exception and must be listed in `allowedSupportDirectories`.
- Every implemented context must define `directoryIntent` in `context.json` for each root directory.
- `directoryIntent` is the manifest-first contract that classifies each root directory as exactly one of:
  - `slice` (feature),
  - `support` (exception),
  - `routes` (composition seam).
- `directoryIntent` entries must document:
  - `purpose`,
  - `allowedWhen`,
  - `expectedConsumers`,
  - `justification`,
  - `createdFor`,
  - `sunsetWhen`.
- Support-directory `expectedConsumers` must declare at least two slices, unless the directory is explicitly tagged as cross-cutting runtime composition (`crossCuttingRuntimeComposition: true`) for approved runtime composition folders such as `request-support` or `seed-support`.
- Structure checks compare declared support-directory `expectedConsumers` with actual support file consumers and fail when they drift.
- Structure checks fail when a root directory exists without `directoryIntent` metadata, including support directories listed in `allowedSupportDirectories`.

Naming standard for support directories:

- Keep reusable technical helpers in `*-support` folders (for example `request-support`, `route-support`, `shell-support`, `seed-support`, `projection-support`).
- `tests` is the only non-`*-support` exception for acceptance or structure tests that span multiple slices.
- Do not use ambiguous folders like `shell`, `helpers`, or `utils` at the bounded-context root.

When structure shifts away from slice locality (for example shared route wiring or shell composition), encode the shift by creating or extending a purpose-specific `*-support` directory and declaring it in `allowedSupportDirectories`.

## Public Surface Rules

Only a bounded context root `index.ts` may export `contextManifest`.

Secondary public surfaces must be real, stable contracts. A surface should either have meaningful public value or not exist.

Allowed public surfaces:

- `.`
- `./client`
- `./server`
- `./web`
- `./routes/*`
- `./seed-support/*`

Surface meanings:

- `.` is the deployable plug-in contract only
- `./client` is browser-safe transport clients, DTOs, and API errors
- `./server` is the provider-owned request and SSR surface for same-context use and approved cross-context request composition
- `./web` is deployable-facing shell, layout, provider, and browser-entry code only
- `./routes/*` is the feature-route surface for generated deployable adapters
- `./seed-support/*` is seed, bootstrap, and test-only support

Private route and request helpers must stay inside the owning bounded context under explicit support folders, not as ad hoc top-level files.

## Deployable Composition

Generated route wrapper files under `deployables/*/app/routes` are an intentional composition seam.

- Bounded contexts own the real route modules.
- Deployables own only host routes and generated wrappers.
- Generated wrappers are tracked, machine-owned files, not a temporary migration artifact.

Generated shell inventories under `deployables/*/app/context-shell.generated.ts` are the matching composition seam for navigation and shell discoverability.

- Bounded contexts declare shell-visible entries in `context.json`.
- Shell-owner contexts own layout chrome, not other contexts' feature nav.
- Deployables consume generated shell inventories instead of hand-curated cross-context navigation.

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

- Auth is upstream for browser authentication journeys and actor-resolution helpers, while Identity facts are projected into Auth for local reads.
- Identity is upstream for user and account references.
- Catalog is upstream for canonical item references.
- Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views.
- Inventory depends on Identity and Catalog sellable-unit structure.
- Marketplace depends on Identity, Auth journey entry points, Catalog sellable-unit identity, and Inventory availability signals.
- Marketplace is downstream of Discovery for browse entry points but remains the owner of listing and offer decisions.
- Ordering depends on Marketplace sellable-unit commitments, Identity account references, and inventory reservation outcomes published after order commitment.
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
