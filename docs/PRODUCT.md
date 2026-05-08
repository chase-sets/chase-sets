# Chase Sets Marketplace Product Brief

## Product Overview

### Vision

Chase Sets is a marketplace designed to make buying and selling trading cards and collectibles **fair, efficient, and transparent**, while optimizing both **purchase experience** and **selling profitability**.

The platform prioritizes:

- Accurate pricing and liquidity
- Low-friction fulfillment
- Fair fee structures
- Scalable catalog and listing architecture
- Data-driven decision making

### Problem Statement

Existing marketplaces present several inefficiencies:

Buying accounts:

- Fragmented listings across sellers
- Inconsistent condition definitions
- Poor visibility into fair market pricing

Selling accounts:

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

Accounts selling products:

- High-volume trading card sellers
- Hobbyists selling duplicates
- Storefront operators
- Bulk sellers of low-value cards

Accounts buying products:

- Collectors completing sets
- Competitive players
- Bulk buyers
- Resellers

## Core Value Propositions

Buying experience:

- Competitive pricing
- Accurate and standardized condition definitions
- Efficient cart building and checkout
- Stable shipping costs

Selling experience:

- Lower fee structure than competitors
- Automated pricing assistance
- Efficient inventory workflows
- Bulk listing capabilities
- Better margins on low-value cards

## Marketplace Economics

### Fee Model

Seller-side marketplace economics:

- Commercial Terms owns seller-side marketplace fee policy.
- Marketplace owns seller confirmation before listing publication or offer acceptance.
- Ordering consumes confirmed Marketplace snapshots when creating orders.
- Fees should be predictable, transparent, and sustainable for low-value-card sellers.

See [Seller Fee Confirmation](../bounded-contexts/marketplace/docs/seller-fee-confirmation.md) for implementation rules.

Buyer responsibilities:

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

- Marketplace economics must remain **sustainable for sellers at scale**
- Fees should be **predictable and transparent**
- Buying accounts should experience **lower total landed cost** compared to competing platforms
- The system should naturally reward **efficient behavior**, not rely solely on rules or penalties
