# Chase Sets Marketplace — Product Brief

---

# 1. Product Overview

## 1.1 Vision

Chase Sets is a marketplace designed to make buying and selling trading cards and collectibles **fair, efficient, and transparent**, while optimizing both **purchase experience** and **selling profitability**.

The platform prioritizes:

- Accurate pricing and liquidity
- Low-friction fulfillment
- Fair fee structures
- Scalable catalog and listing architecture
- Data-driven decision making

---

## 1.2 Problem Statement

Existing marketplaces present several inefficiencies:

### Buying Accounts

- Fragmented listings across sellers
- Inconsistent condition definitions
- Poor visibility into fair market pricing

### Selling Accounts

- High marketplace sales fees
- Inefficient pricing tools
- Shipping losses on low-value cards
- Limited automation and analytics

---

## 1.3 Goals

### Primary Goals

- Create a marketplace optimized for **high-volume, low-value cards**
- Reduce shipping inefficiencies
- Provide transparent pricing mechanisms
- Enable scalable listing and catalog management
- Support automation and intelligent repricing

### Secondary Goals

- Enable advanced analytics and forecasting
- Support bulk inventory ingestion
- Provide strong APIs and automation tooling

---

# 2. Target Users

## 2.1 Accounts Selling Products

- High-volume trading card sellers
- Hobbyists selling duplicates
- Storefront operators
- Bulk sellers of low-value cards

---

## 2.2 Accounts Buying Products

- Collectors completing sets
- Competitive players
- Bulk buyers
- Resellers

---

# 3. Core Value Propositions

## 3.1 Buying Experience

- Competitive pricing
- Accurate and standardized condition definitions
- Efficient cart building and checkout
- Stable shipping costs

---

## 3.2 Selling Experience

- Lower fee structure than competitors
- Automated pricing assistance
- Efficient inventory workflows
- Bulk listing capabilities
- Better margins on low-value cards

---

# 4. Marketplace Economics

## 4.1 Fee Model

Seller fees:

- Seller-confirmed per-unit marketplace sales fee snapshot
- Permanent for each listed unit until that unit is sold
- Positive fractional-cent fees round up to the next cent
- Price edits and quantity-cap edits require a new confirmed quote and replace the locked snapshot
- Partial sales, pause, resume, and sold-out availability changes do not recalculate fees

See [Permanent Listing Fees](./PERMANENT-LISTING-FEES.md) for the listing, offer, ordering, and visibility rules.

Buyer responsibilities:

- Buyer payment processing fees, owned by separate Payments policy
- Shipping costs (adjusted by rebate model)

Shipping model:

- Buyer pays shipping based on weight or method
- Shipping rebate applied to reduce effective cost
- Rebate capped at approximately 5% of order value

---

## 4.2 Economic Design Goals

The marketplace is designed to incentivize:

- Larger orders
- Multiple items per seller
- Consolidated shipping
- Multiple bids or purchases per buyer

The marketplace aims to minimize:

- Negative-margin transactions
- Shipping losses on low-value cards
- Excessive payment processing overhead

---

## 4.3 Guiding Principles

- Marketplace economics must remain **sustainable for sellers at scale**
- Fees should be **predictable and transparent**
- Buying accounts should experience **lower total landed cost** compared to competing platforms
- The system should naturally reward **efficient behavior**, not rely solely on rules or penalties

---
