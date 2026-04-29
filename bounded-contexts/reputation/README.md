# Reputation Bounded Context

## Purpose

Reputation owns post-transaction ratings, written feedback, and the canonical review summary for accounts.

## Owns

- Review records tied to completed commerce
- Numeric ratings
- Written feedback
- Review submission, edit, and withdrawal lifecycle
- Review eligibility rules for completed transactions
- Canonical review summary snapshots (average rating, review count, distribution)
- Public review visibility state limited to active vs withdrawn

## Does Not Own

- Order lifecycle truth
- Shipment delivery truth
- Payment/refund outcomes
- Marketplace ranking, merchandising, or listing placement logic
- Review moderation, abuse enforcement, or badge systems

## Ubiquitous Language

Reputation terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Review
- Review Summary
- Review Eligibility Policy

## Incoming Dependencies

- Identity for author and subject account references
- Ordering for order references and counterparty pairing
- Fulfillment for delivery-complete signals that unlock review eligibility

## Outgoing Integration Events

- `ReviewSubmitted`
- `ReviewUpdated`
- `ReviewWithdrawn`
- `ReviewSummaryUpdated`

## Invariants

1. A review is always attached to an Order, never directly to a listing or shipment.
2. Only accounts that were counterparties on the same completed order may review each other.
3. Reputation allows at most one active review per order, per direction (`authorAccountId` -> `subjectAccountId`).
4. The canonical review summary is derived only from active reviews.
5. Reputation is downstream of commerce execution and must not block ordering, payment, or fulfillment flows.

## Open Extraction Candidates

- Trust and safety or moderation can be extracted later if content governance becomes materially more complex.
