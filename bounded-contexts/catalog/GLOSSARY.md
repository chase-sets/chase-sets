# Catalog & Marketplace — Ubiquitous Language Glossary

This document defines the canonical terminology used across the platform.  
All engineering, product, documentation, and API contracts must use these terms consistently.

---

# Catalog Domain

## Dimension

A selectable axis along which versions of an Item can differ.

Examples:

- Condition
- Form
- Grading Company
- Grade
- Color
- Size
- Language

A Dimension defines the **space in which versions are formed**.

---

## Choice

A selectable value within a Dimension.

Examples:

- Condition → Near Mint
- Form → Graded
- Grade → 10

A Choice represents one possible state of a Dimension.

Choices:

- Have localized display labels
- Have display ordering
- May optionally include numeric metadata (e.g., grade = 9.5, 10)

---

## Field

A descriptive attribute of an Item that does not create versions.

Examples:

- Manufacturer
- Brand
- Game
- Set / Expansion
- Release Date
- HP
- Artist
- Weight

Fields describe Items but do not define variation.

Fields may have behavior flags (e.g., filterable, searchable), but remain a single entity type.

---

## Field Value

The value of a Field for a specific Item.

Examples:

- Release Date = 2020-10-01
- Manufacturer = TPCI
- HP = 330

Field defines structure.  
Field Value is the item-specific instance of that structure.

---

## Component

A reusable bundle of catalog configuration used to compose Blueprints.

A Component may define:

- Applicable Fields
- Applicable Dimensions
- Allowed Choice subsets
- Required/optional behavior
- Display hints

Examples:

- TCG Raw
- TCG Graded
- Pokémon Metadata
- Apparel Basics

Components are composable and do not use inheritance.

---

## Blueprint

The structural definition of a product type.

A Blueprint defines:

- Which Dimensions apply
- Which Fields apply
- Rules for forming valid Versions
- Canonical ordering of Dimensions (for deterministic version identity)

Examples:

- Trading Card Single
- Graded Card
- Sealed Product
- Apparel Item

Blueprints define structure, not individual products.

---

## Category

A consumer-facing grouping used for browsing and merchandising.

Examples:

- Pokémon
- Magic: The Gathering
- Funko

Categories organize Items but do not control version logic.

---

## Item

The root catalog record representing a specific thing being sold.

Examples:

- Charizard ex Promo
- Pikachu Plush

An Item:

- References a Blueprint
- Contains Field Values
- Represents the base identity of the product

Items exist independently of condition, grading, or other selections.

---

## Selection

A set of chosen Choices across one or more Dimensions.

Examples:

- Condition = Near Mint
- Form = Graded, Grade = 10

A Selection:

- May be partial or complete
- Represents user intent or configuration state
- Has no independent identity

Selections are used for validation and UI state.

---

## Version

A complete and valid Selection for a specific Item.

Examples:

- Raw Near Mint Charizard
- PSA 10 Charizard

A Version:

- Represents a concrete sellable configuration
- Has deterministic identity derived from Item + Selection
- Is computed rather than stored as a primary entity

Version identity is based only on:

- Item ID
- Dimension IDs
- Choice IDs
- Canonical dimension ordering

Labels and display order do not affect identity.

---

# Marketplace Domain

## Listing

A seller’s offer for a specific Item Version.

A Listing includes:

- Item reference
- Version reference
- Selection snapshot
- Price
- Quantity
- Seller

Listings represent market supply.

---

## Bid (Offer)

A buyer’s intent to purchase a specific Item Version.

A Bid includes:

- Item reference
- Version reference
- Selection snapshot
- Price
- Quantity
- Buyer

Bids represent market demand.

---

# Conceptual Flow

The relationships between entities:

Dimension → Choice → Selection → Version → Listing/Bid
↑
Item
↑
Blueprint
↑
Component

This progression reflects how:

1. Structure is defined (Dimension, Field, Component, Blueprint)
2. Items are created
3. Selections are made
4. Versions are formed
5. Market activity occurs

---

# Guiding Principles

1. Dimensions create versions.
2. Fields describe items.
3. Selections represent intent.
4. Versions represent sellable configurations.
5. Listings and Bids always reference Versions.
6. Identity is derived from stable IDs, never display labels.
