# Collections Bounded Context

## Purpose

Collections owns Saved Lists: account-owned, ordered sets of exact Catalog Products kept for curation, tracking, sharing, copying, and later account workflows. A Saved List records intent, not stock or financial truth. My Collection may compose Saved Lists with Inventory-owned Owned Cards, but the customer surface does not move behavior between contexts.

The context publishes the replay-stable Saved List aggregate, command contracts, and owner read models through `@chase-sets/collections/server`. The Saved List Inventory handoff snapshots selected owner lines into Inventory's review-first import. The valuation slice consumes those contracts and Pricing estimate facts without changing Saved List state or importing slice internals.

## Owns

- Saved List identity, owner, details, lifecycle, visibility state, and cover-line selection.
- Ordered Saved List Lines keyed by exact Catalog Product selection.
- Tracked Quantity and private line notes/tags.
- Expected-version concurrency, command idempotency receipts, and bounded line batches.
- Versioned Saved List event and owner/viewer snapshot contracts.
- Authorization and immutable selected-line source snapshots for Inventory handoff.
- Current Saved List estimated market value and explicit estimate coverage.
- Recent active Saved List picker rows and expiring Anonymous Saved List Intents used to resume registration.
- Event-sourced sharing disclosure and revocable unlisted access policy.
- Public-safe shared-page projection, access decisions, cache/SEO posture, and moderation adapter boundary.

## Does Not Own

- Inventory quantity, Inventory Item identity, acquisition cost, location, SKU, holds, or availability.
- Asking prices, Listings, realized or unrealized profit and loss, or account-wide value history.
- Catalog Product identity or selected Option validity; Catalog is consulted through a host port before a Product enters a list.
- Public rendering UI, collaboration, ownership transfer, or live copy synchronization.
- Market estimation algorithms, estimate publication, cost basis, gain/loss, or valuation history.
- My Collection shell/navigation composition.

## Ubiquitous Language

Collections terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Saved List

## Incoming Dependencies

- Identity supplies the account reference carried by event audit context.
- Catalog validates exact Product selections through the `savedListProductCatalog` host port. Collections never reads Catalog tables.
- Inventory accepts authorized Saved List source snapshots through the `inventorySavedListImportBatchCreator` host port and remains authoritative for validation, locations, stock changes, durable work, and review status.
- Pricing publishes current Product-scoped market estimates. Collections projects disclosure-approved fields and never reads Pricing tables.

## Outgoing Integration Events

- `collections.saved-list.created`
- `collections.saved-list.details-changed`
- `collections.saved-list.archived`
- `collections.saved-list.visibility-changed`
- `collections.saved-list.cover-changed`
- `collections.saved-list.line-added`
- `collections.saved-list.line-changed`
- `collections.saved-list.line-removed`
- `collections.saved-list.line-reordered`

## Read Models

- `collections_saved_list_summaries` and `collections_saved_list_lines` replay Saved List events into owner-scoped summaries and deterministic line order.
- `collections_catalog_*` mirrors display identity and Product-option labels from Catalog events. Collections queries join only these consumer-owned tables; they never read Catalog tables on the request path.
- Account list queries use an immutable creation keyset and a captured creation-position fence. The cursor carries the original total and filter fingerprint so a page sequence stays stable while new Lists are created.
- Missing, retired, and temporarily unavailable Products remain distinct display states. Catalog changes update the consumer mirror and never rewrite Saved List events.
- Projection groups use owned-table truncation followed by source replay. Catalog and Collections subscriptions can replay in either order because enrichment is joined at read time.

The authenticated query API is mounted at `/api/collections/saved-lists`. Its list response is a `saved-lists` module so My Collection can compose it beside Inventory-owned Overview and Owned Cards without copying Inventory rows into Collections.

## Invariants

1. A Saved List belongs to exactly one account and is private when created.
2. A Saved List contains at most one line for an exact Product selection; repeat adds merge Tracked Quantity into the existing stable line.
3. Saved List Lines retain the resolved Catalog Item, Product, and selected Options but do not copy Catalog display truth.
4. Archived Saved Lists cannot be changed.
5. Only the owner account can use the command API or receive an owner snapshot.
6. Viewer snapshots omit private notes and tags by construction and can independently hide Tracked Quantity.
7. Inventory, cost, Listing, availability, and profit fields never enter Saved List state or events.
8. A missing or stale estimate is never represented as zero, and low-confidence coverage remains explicit.
9. Shared valuation is absent whenever tracked quantities are hidden or Pricing has not approved public disclosure.
10. Shared-page reads fail closed, use only the public-safe projection, and never return private notes/tags or capability verifiers.
11. Unlisted secrets are revocable capabilities; only one-way verifiers enter durable state.

## Tests

Run `pnpm --filter @chase-sets/collections run test:watch` for the inner loop. Run `pnpm --filter @chase-sets/collections run test` before opening a pull request.

## Security

The [Saved List Sharing Threat Model](./docs/saved-list-sharing-threat-model.md) defines the projection allowlist, unlisted capability handling, normalized failures, cache/SEO posture, and verification obligations.
