# Settlement Domain Glossary

This glossary defines the canonical terminology for the Settlement bounded context.

## Wallet

A **Wallet** is the balance container for an account within the marketplace ledger.

## Ledger Entry

A **Ledger Entry** is the atomic accounting record that explains a balance change.

## Rebate

A **Rebate** is the Settlement-owned ledger entry kind used when the marketplace credits an account for a Commercial Terms-derived allowance, such as a shipping allowance.

Notes:

- Settlement owns rebate postings and balance effects.
- Commercial Terms owns the configurable Shipping Allowance percentage that creates the upstream economics snapshot.
- A Commercial Terms revision affects only future resolved snapshots; existing rebate ledger entries remain historical accounting facts.

## Balance

A **Balance** is the current computed financial position of an account derived from ledger entries.

## Payout

A **Payout** is the transfer of eligible marketplace funds to an account.

## Payout Release Hold

A **Payout Release Hold** is the Settlement-owned pending state that keeps sale proceeds and shipping allowances out of available balance until delivery, risk, support, and aging rules clear.

Notes:

- Payout Release Holds apply to account wallet credits, not to Stripe charge authorization or capture.
- Returned shipments, fulfillment exceptions, active support holds, manual payout review, untrusted account state, and high-dollar seller exposure can extend or prevent release.
- Settlement owns the release decision even when Stripe payment risk checks pass.

## Payout Batch

A **Payout Batch** is a grouped payout execution run.

## Statement

A **Statement** is the financial summary published for an account over a period of time.
