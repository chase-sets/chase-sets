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

## Protection Reserve Contribution

A **Protection Reserve Contribution** is the Settlement-owned financial fact recorded for a captured order's Order Protection amount, including its immutable allowance-funded and overage-funded shares.

Notes:

- Contributions are independent of Marketplace Sales Fees, including Founders Window 0% fee orders.
- Refund reversals preserve the original funding split and converge to the full contribution on a full-order refund.
- Replay uses deterministic fact identities, so a contribution or reversal is recorded at most once.

## Balance

A **Balance** is the current computed financial position of an account derived from ledger entries.

## Payout

A **Payout** is the transfer of eligible marketplace funds to an account.

## Connected Payout Account

A **Connected Payout Account** is the provider account that can receive Chase Sets marketplace payout funds for an account.

Notes:

- Settlement owns the provider-neutral reference, readiness, and payout relationship.
- Stripe owns the provider account, verification requirements, sensitive payout destination collection, and provider risk controls.
- A Connected Payout Account does not change Wallet ownership; Settlement remains the source of truth for account balances and payout eligibility.

## Payout Setup

**Payout Setup** is the account workflow for creating or updating the Connected Payout Account information required before eligible funds can be paid out.

Notes:

- Chase Sets owns the authenticated account page, role authorization, support-safe status language, and recovery paths.
- Stripe embedded components own sensitive requirement collection, verification UI, service-agreement presentation, and payout destination handling.
- Settlement treats provider completion, webhooks, and readiness refreshes as inputs to provider-neutral Payout Setup status.

## Payout Account Management

**Payout Account Management** is the account workflow for maintaining Connected Payout Account requirements after initial setup, including provider-requested updates and payout destination changes.

Notes:

- Payout Account Management is separate from requesting a Payout.
- Account operators manage provider requirements through Chase Sets-hosted account pages backed by Stripe embedded components.

## Provider Requirement

A **Provider Requirement** is a provider-issued requirement identifier that blocks or limits payout readiness until the account operator supplies the required information through provider-managed collection.

Notes:

- Settlement stores provider requirement identifiers only as readiness facts and support-safe troubleshooting signals.
- Provider Requirement identifiers are not a substitute for storing sensitive identity, tax, bank, or verification document data.

## Payout Release Hold

A **Payout Release Hold** is the Settlement-owned pending state that keeps sale proceeds and shipping allowances out of available balance until delivery, risk, support, and aging rules clear.

Notes:

- Payout Release Holds apply to account wallet credits, not to Stripe charge authorization or capture.
- Returned shipments, fulfillment exceptions, active support holds, manual payout review, untrusted account state, and high-dollar seller exposure can extend or prevent release.
- Settlement owns the release decision even when Stripe payment risk checks pass.

## Chargeback Clawback

A **Chargeback Clawback** is the Settlement-owned ledger adjustment that recovers seller exposure after Payments reports a processor dispute or chargeback.

Notes:

- Chargeback Clawbacks are posted through Wallet commands and may create a negative available balance when released funds have already left the seller wallet.
- Active chargeback holds keep pending sale proceeds and shipping allowances from becoming available while the processor dispute remains open or lost.
- A won chargeback releases the active hold with a matching Wallet credit; payout-reversal mechanics remain owned by Payout.

## Negative Balance

A **Negative Balance** is a Wallet state where chargeback, refund, or payout recovery obligations exceed the account's available balance.

Notes:

- Settlement records the balance truth in the Wallet ledger.
- Follow-up consumers use this vocabulary to decide recovery, payout blocking, or operator workflows without reinterpreting the original payment processor dispute.
- New sale proceeds and shipping allowances offset a Negative Balance before any remaining funds enter normal payout release holds.

## Collections

**Collections** is the Settlement-owned Negative Balance lifecycle state for an account whose Wallet remains negative at or beyond the configured threshold for the configured grace period.

Notes:

- Collections pauses new listings through Marketplace Seller Listing Availability with the platform `operations` reason.
- Collections keeps payout requests paused until the Wallet recovers to `in-good-standing`.
- Manual repayment through a payment against the balance is a follow-up path; the current recovery path is sale-credit offset or audited operator adjustment.

## Payout Batch

A **Payout Batch** is a grouped payout execution run.

## Statement

A **Statement** is the financial summary published for an account over a period of time.
