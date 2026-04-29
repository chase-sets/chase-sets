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
| [Commercial Terms](./commercial-terms/README.md) | Own marketplace fee policy, payment fee policy, and account-specific commercial agreements. |
| [Marketplace](./marketplace/README.md) | Own listing and offer workflows before an order exists. |
| [Ordering](./ordering/README.md) | Own checkout normalization and commercial commitment. |
| [Fulfillment](./fulfillment/README.md) | Own shipment execution and delivery state. |
| [Reputation](./reputation/README.md) | Own post-transaction ratings, written feedback, and canonical review summaries. |
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

Inside a bounded context, avoid generic feature folders such as `infrastructure`, `shared`, and ad hoc root-level helper directories.

Prefer:

- slice-local files when behavior belongs to one slice
- purpose-specific names such as `route-support`, `request-support`, `projection-support`, `shell-support`, `seed-support`, `read-models`, `projections`, or `persistence` when context-local code is reused across slices

## Feature-Default Directory Plan

Bounded contexts should read as **feature-first** by default.

Top-level directory intent:

- Implemented contexts use explicit root buckets: `features/`, `support/`, `routes/`, and optional `tests/`.
- Implemented context roots keep only canonical entrypoints and docs: `context.json`, `package.json`, `index.ts`, `api.ts`, `client.ts`, `server.ts`, `web.ts`, `README.md`, `GLOSSARY.md`, and `ids.ts` when the context owns typed IDs.
- `slices` entries in `context.json` are logical feature slices and must resolve to `features/<slice>/`.
- `allowedSupportDirectories` entries in `context.json` are logical support modules and must resolve to `support/<name>/`.
- Feature roots are directory-only seams. Keep slice code under `api/`, `domain/`, `read-model/`, `ui/`, `integrations/`, and slice-local `tests/` when needed.
- Every implemented context must define `directoryIntent` in `context.json` for each logical slice or support directory.
- `directoryIntent` is the manifest-first contract that classifies each logical directory as exactly one of:
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
- Support-directory `expectedConsumers` must describe the slices or composition seams that really consume the support module.
- Structure checks compare declared support-directory `expectedConsumers` with actual support file consumers and fail when they drift.
- Structure checks fail when a declared slice is missing from `features/` or a declared support directory is missing from `support/`.

Naming standard for support directories:

- Keep reusable technical helpers in `*-support` folders (for example `request-support`, `route-support`, `shell-support`, `seed-support`, `projection-support`).
- `tests/` is the only non-`*-support` root bucket exception for acceptance or structure tests that span multiple slices.
- Do not place ambiguous folders like `shell`, `helpers`, or `utils` directly at the bounded-context root; keep them under `features/` or `support/`.

When structure shifts away from slice locality (for example shared route wiring or shell composition), encode the shift by creating or extending a purpose-specific `*-support` directory and declaring it in `allowedSupportDirectories`.

## Public Surface Rules

Only a bounded context root `index.ts` may export `contextManifest`.

Secondary public surfaces must be real, stable contracts. A surface should either have meaningful public value or not exist.

Allowed public surfaces:

- `.`
- `./context`
- `./client`
- `./server`
- `./web`
- `./routes/*`
- `./seed-support/*`
- `./host-config`

Surface meanings:

- `.` is the deployable plug-in contract only
- `./context` is the context manifest contract used by structure checks and composition tooling
- `./client` is browser-safe transport clients, DTOs, and API errors
- `./server` is the provider-owned request and SSR surface for same-context use and approved cross-context request composition
- `./web` is deployable-facing shell, layout, provider, and browser-entry code only
- `./routes/*` is the feature-route surface consumed by manifest-driven deployable composition
- `./seed-support/*` is seed, bootstrap, and test-only support
- `./host-config` is an Auth-specific host integration surface for authentication entry points

Private route and request helpers must stay inside the owning bounded context under explicit support folders, not as ad hoc top-level files.

## Deployable Composition

The platform host resolves route and shell composition directly from bounded-context manifests.

- Bounded contexts own the real route modules and shell contributions.
- Deployables own only host routes, layout, auth wiring, and runtime bootstrap.
- `infrastructure/platform-runtime` is the canonical projection of manifest-driven route and shell composition.

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
- `MembershipId`
- `RoleId`
- `InvitationId`
- `ConsentId`
- `ContactMethodId`
- `VerificationId`
- `CredentialId`
- `AuthenticationMethodId`
- `SessionId`
- `ApiKeyId`
- `InventoryItemId`
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
- `DimensionId`
- `OptionId`
- `FieldId`
- `ComponentId`
- `BlueprintId`
- `CategoryId`

Catalog also owns the `SelectedOptionEntry` shape used to describe resolved product selections. `product_id` is derived from catalog truth and used at API boundaries, but it is not currently exported as a shared typed ID.

## Upstream and Downstream Relationships

- Auth is upstream for browser authentication journeys and actor-resolution helpers, while Identity facts are projected into Auth for local reads.
- Identity is upstream for user and account references.
- Catalog is upstream for canonical item references.
- Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views.
- Inventory depends on Identity and Catalog product structure.
- Commercial Terms depends on Identity account references and account classification facts.
- Marketplace depends on Identity, Auth journey entry points, Catalog product identity, and Inventory availability signals.
- Marketplace depends on Commercial Terms for resolved seller fee snapshots used in listing management.
- Marketplace is downstream of Discovery for browse entry points but remains the owner of listing and offer decisions.
- Ordering depends on Marketplace product commitments, Commercial Terms resolution, Identity account references, and inventory reservation outcomes published after order commitment.
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

1. Inventory owns bulk stock ingestion and seller stock for a resolved product.
2. Commercial Terms owns fee schedules, negotiated overrides, and deterministic seller commercial snapshots.
3. Marketplace owns listing publication and offer negotiation for products.
4. Ordering owns cart decomposition and order creation for committed products.
5. Fulfillment owns shipment state and tracking.
6. Reputation owns post-transaction ratings, written feedback, and aggregate review summaries.
7. Payments owns charge and refund execution.
8. Settlement owns ledger adjustments and payout eligibility.
9. Pricing owns recommendations but never directly mutates listings or inventory.
10. Insights owns reporting and forecasting without owning source transactions.
