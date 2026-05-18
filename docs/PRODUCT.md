# Chase Sets Marketplace Product Brief

## Product Overview

### Vision

Chase Sets is a marketplace designed to make buying and selling trading cards and collectibles **fair, efficient, and transparent**, while optimizing both **purchase experience** and **selling profitability**.

Every account is a full marketplace participant. Accounts may buy, sell, or do both over time; buying and selling describe transaction posture, not account identity.

The platform prioritizes:

- Accurate pricing and liquidity
- Low-friction fulfillment
- Fair fee structures
- Scalable catalog and listing architecture
- Data-driven decision making

### Problem Statement

Existing marketplaces present several inefficiencies:

Accounts purchasing products:

- Fragmented listings across sellers
- Inconsistent condition definitions
- Poor visibility into fair market pricing

Accounts listing and selling products:

- High marketplace sales fees
- Inefficient pricing tools
- Shipping losses on low-value cards
- Limited automation and analytics

### Goals

Primary goals:

- Create a marketplace optimized for **high-volume, low-value cards**
- Reduce shipping inefficiencies
- Provide transparent pricing mechanisms
- Enable scalable listing and catalog management
- Support automation and intelligent repricing

Secondary goals:

- Enable advanced analytics and forecasting
- Support bulk inventory ingestion
- Provide strong APIs and automation tooling

## Target Users

Target segments describe the account's current job in the marketplace, not separate buyer or seller account classes.

Listing and selling jobs:

- High-volume trading card sellers
- Hobbyists selling duplicates
- Storefront operators
- Bulk sellers of low-value cards

Purchasing jobs:

- Collectors completing sets
- Competitive players
- Bulk buyers
- Resellers

## Core Value Propositions

Purchasing experience:

- Competitive pricing
- Accurate and standardized condition definitions
- Efficient cart building and checkout
- Stable shipping costs

Listing and selling experience:

- Lower fee structure than competitors
- Automated pricing assistance
- Efficient inventory workflows
- Bulk listing capabilities
- Better margins on low-value cards

## Marketplace Economics

### Fee Model

Selling-account marketplace economics:

- Commercial Terms owns seller-side marketplace fee policy.
- Marketplace owns seller confirmation before listing publication or offer acceptance.
- Ordering consumes confirmed Marketplace snapshots when creating orders.
- Fees should be predictable, transparent, and sustainable for low-value-card selling accounts.

See [Marketplace Sales Fee Confirmation](../bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md) for implementation rules.

Purchasing-account responsibilities:

- Buyer marketplace checkout fees, owned by Payments policy
- Shipping costs (adjusted by rebate model)

Shipping model:

- Buyer pays shipping based on weight or method
- Shipping rebate applied to reduce effective cost
- Rebate capped at approximately 5% of order value

### Economic Design Goals

The marketplace is designed to incentivize:

- Larger orders
- Multiple items per seller
- Consolidated shipping
- Multiple bids or purchases per buyer

The marketplace aims to minimize:

- Negative-margin transactions
- Shipping losses on low-value cards
- Excessive payment processing overhead

### Guiding Principles

- Marketplace economics must remain **sustainable for selling accounts at scale**
- Fees should be **predictable and transparent**
- Purchasing accounts should experience **lower total landed cost** compared to competing platforms
- The system should naturally reward **efficient behavior**, not rely solely on rules or penalties

## Account Role Guidance

- Do not create buyer-only or seller-only account identities, profile classes, or product journeys.
- Use account language for identity, permissions, onboarding, inventory, listings, wallet, and account settings.
- Use buyer/seller language only for transaction roles, transaction projections, and policy copy where the role is part of the commercial fact.
- Treat Stripe onboarding, payout readiness, tax identity, terms acceptance, and verification as account capabilities that enable selling activity, not as a seller identity.
