# Discovery Bounded Context

## Purpose

Discovery owns the browse, search, and detail experience for catalog items.

## Owns

- Search query behavior
- Search relevance and sort behavior
- Browse-oriented read models
- Filter state and facet presentation
- Catalog item detail presentation models
- Search index rebuild and projection workflows

## Does Not Own

- Canonical catalog item truth
- Listing lifecycle or offer lifecycle
- Inventory availability truth
- Ordering, payment, or fulfillment decisions

## Ubiquitous Language

Discovery terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Models

- Discovery Query
- Search Index
- Search Result
- Result Set
- Filter State
- Detail Page

## Incoming Dependencies

- Catalog for canonical item, category, blueprint, dimension, and field facts
- Marketplace for future visibility or listing signals when browse behavior needs commercial state

## Outgoing Integration Events

- None in the current extraction

## Invariants

1. Discovery is downstream and projection-oriented.
2. Discovery may reshape upstream facts for search and browse, but it does not take ownership of source transactions.
3. Search, filters, and item detail stay in one vertical slice so browse behavior is evolved together.
4. Discovery may preserve marketplace-branded public routes while still owning the implementation.

## Open Extraction Candidates

- Personalized recommendations can be extracted later if discovery evolves beyond shared browse behavior into account-specific ranking or merchandising workflows.
