# Collections Bounded Context

## Purpose

Collections owns Saved Lists: account-owned, ordered sets of exact Catalog Products kept for curation, tracking, sharing, copying, and later account workflows. A Saved List records intent, not stock or financial truth. My Collection may compose Saved Lists with Inventory-owned Owned Cards, but the customer surface does not move behavior between contexts.

This foundation publishes the replay-stable Saved List aggregate and command contracts through `@chase-sets/collections/server`. Later slices add read models, routes, sharing, valuation, Inventory handoff, and presentation without importing slice internals.

## Owns

- Saved List identity, owner, details, lifecycle, visibility state, and cover-line selection.
- Ordered Saved List Lines keyed by exact Catalog Product selection.
- Tracked Quantity and private line notes/tags.
- Expected-version concurrency, command idempotency receipts, and bounded line batches.
- Versioned Saved List event and owner/viewer snapshot contracts.

## Does Not Own

- Inventory quantity, Inventory Item identity, acquisition cost, location, SKU, holds, or availability.
- Asking prices, Listings, realized or unrealized profit and loss, or account-wide value history.
- Catalog Product identity or selected Option validity; Catalog is consulted through a host port before a Product enters a list.
- Public rendering, unlisted capabilities, disclosure policy, collaboration, or ownership transfer.
- My Collection shell/navigation composition.

## Ubiquitous Language

Collections terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Saved List

## Incoming Dependencies

- Identity supplies the account reference carried by event audit context.
- Catalog validates exact Product selections through the `savedListProductCatalog` host port. Collections never reads Catalog tables.

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

## Invariants

1. A Saved List belongs to exactly one account and is private when created.
2. A Saved List contains at most one line for an exact Product selection; repeat adds merge Tracked Quantity into the existing stable line.
3. Saved List Lines retain the resolved Catalog Item, Product, and selected Options but do not copy Catalog display truth.
4. Archived Saved Lists cannot be changed.
5. Only the owner account can use the command API or receive an owner snapshot.
6. Viewer snapshots omit private notes and tags by construction and can independently hide Tracked Quantity.
7. Inventory, cost, Listing, availability, and profit fields never enter Saved List state or events.

## Tests

Run `pnpm --filter @chase-sets/collections run test:watch` for the inner loop. Run `pnpm --filter @chase-sets/collections run test` before opening a pull request.
