# Catalog Bounded Context

## Purpose

Catalog owns the canonical product model for what can be bought or sold in Chase Sets.

## Owns

- Product taxonomy
- Product set definitions
- Canonical item identity
- Print, edition, and variant identity
- Searchable item metadata
- Condition vocabulary and grading labels used as shared reference data

## Does Not Own

- Seller-specific quantity
- Seller acquisition cost
- Asking prices
- Buyer offers

## Ubiquitous Language

Catalog terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Product Line
- Product Set
- Catalog Item
- Condition Definition

## Incoming Dependencies

- Identity for administrative actors who curate or maintain catalog records.

## Outgoing Integration Events

- `CatalogItemCreated`
- `CatalogItemUpdated`
- `CatalogItemRetired`
- `ConditionDefinitionPublished`

## Invariants

1. A sellable item has one canonical catalog identity.
2. Catalog metadata must be reusable across all sellers.
3. Inventory and Marketplace may reference catalog IDs but may not redefine item structure.
4. Condition definitions are shared reference data, not seller-owned state.

## Open Extraction Candidates

- Search indexing and merchandising remain downstream projections, not separate bounded contexts.
