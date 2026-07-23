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

## Protection Coverage

A **Protection Coverage** is the Settlement-owned reservation of the platform-funded portion of a support remedy against available protection funds (ADR 0022). Settlement reserves it when Platform Operations requests coverage, consumes exactly the reserved amount when the correlated refund completes, and releases it for remedies that never refund.

Notes:

- A coverage belongs to exactly one remedy and one currency pool; its `coverageId` is present iff the platform-funded portion is positive.
- Settling a coverage emits `settlement.protection-coverage.settled.v1` only after the seller and platform postings are durable, which is the single reconciliation point that releases the correlated support hold.
- Reserve, settle, release, and expire are exactly-once by `coverageId`, so duplicate or replayed facts never double-consume the reserve.

## Refund Liability Allocation

A **Refund Liability Allocation** is the Settlement-owned reconciliation of a completed refund into its authorized seller-funded and platform-funded portions. Settlement posts the seller portion to the seller ledger, consumes the platform portion from the reserved Protection Coverage, and never charges the seller for a platform-covered remedy.

Notes:

- A refund with no authorized allocation is seller-funded by the documented compatibility default, preserving the legacy seller-debit behavior.
- Allocation components are non-negative and sum exactly to the completed refund; a mismatched, over-reservation, or wrong-currency allocation is quarantined into an operator repair queue rather than charged to the seller.
- A wrong or legacy seller debit is corrected only through the governed Wallet Adjustment mechanism (ADR 0020), append-only and correlated, never by rewriting history.

## Protection Recovery

A **Protection Recovery** is Settlement's immutable attribution of Inventory-reported recovered-return value to the settled platform-funded Protection Coverage for the same Remedy. It preserves gross proceeds and direct costs separately; the net amount replenishes or reduces protection-pool availability without changing the original refund or coverage settlement.

## Balance

A **Balance** is the current computed financial position of an account derived from ledger entries.

## Account Linkage

An **Account Linkage** is Settlement's event-sourced lifecycle for one opaque risk-cluster reference. Its `flagged` fact publishes the current linked account set and signal kind for downstream pair-scoped integrity decisions; its `cleared` fact reverses that state while retaining the last set so consumers can converge by replay. Raw address and payment-instrument source material remains private to Settlement.

## Counterparty Linkage Flag

A **Counterparty Linkage Flag** is Settlement's event-sourced internal fact that two or more accounts share an enabled risk-cluster signal. A scheduled closer reads active shared-instrument and shared-address membership from Settlement's projected risk sources, then commands one Account Linkage aggregate per opaque cluster reference to publish `settlement.account-linkage.flagged`; an authorized clear commands the same aggregate to publish `settlement.account-linkage.cleared`.

Notes:

- The fact carries only the linked account identifiers, the signal kind, and a random 256-bit cluster identifier assigned by Settlement's private durable mapping. The identifier cannot be reproduced by enumerating address or payment-instrument candidates, and raw source material never leaves Settlement.
- A Counterparty Linkage Flag informs stats-scoped downstream integrity handling. It does not block orders, offers, payouts, or account access.
- Repeated closer passes with the same members publish nothing; a changed member set republishes the flag, and a still-shared cluster is re-raised after a clear.

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

## Support Hold

A **Support Hold** is the Settlement-owned lifecycle that keeps an order's held funds from being paid to the seller while a support case is active. Settlement places it once when the case opens and records exactly one terminal outcome: released when the case ends without applying the funds to a refund, or consumed when a refund resolution applies the funds to the buyer's refund.

Notes:

- A Support Hold is correlated to one support request and order and carries the durable buyer and seller transaction-party identifiers needed for support-safe routing.
- Released and consumed are mutually exclusive terminal outcomes; replayed case facts do not place or terminate the hold twice.
- Provider-risk holds and their payout-internal details are not Support Holds and do not publish the `settlement.support-hold.{placed,released,consumed}.v1` facts.

## Chargeback Clawback

A **Chargeback Clawback** is the Settlement-owned ledger adjustment that recovers seller exposure after Payments reports a processor dispute or chargeback.

Notes:

- Chargeback Clawbacks are posted through Wallet commands and may create a negative available balance when released funds have already left the seller wallet.
- Active chargeback holds keep pending sale proceeds and shipping allowances from becoming available while the processor dispute remains open or lost.
- A won chargeback releases the active hold with a matching Wallet credit; payout-reversal mechanics remain owned by Payout.

## Wallet Adjustment

A **Wallet Adjustment** is a Settlement-owned, cash-equivalent correction to an account's Wallet balance, requested by one authorized platform operator, approved by a different authorized platform operator, and posted as exactly one immutable `adjustment`-kind Wallet Ledger Entry. It is a governed path onto the existing available/pending balance, not a second balance type.

Notes:

- An available adjustment credit is ordinary available balance: spendable against a `platform-purchase` debit and payoutable under the same payout-readiness and clearance rules as any other available balance. There is no adjustment-specific clearance window.
- A Wallet Adjustment is always cash-equivalent. It is distinct from the future, not-yet-built **Marketplace Credit** (owned by #4891): promotional or prepaid, non-withdrawable, usage-scoped value that must never share the Wallet Adjustment command, lifecycle, reason-code taxonomy, or available-balance total.
- A Wallet Adjustment is distinct from a Payments-owned **Refund** (Payments `GLOSSARY.md`): a Refund is the external processor-rail reversal of captured buyer funds; a Wallet Adjustment coded `refund-correction` is the internal wallet-side correction that supplements or corrects a Refund's wallet consequence, never the external transaction itself.
- A Wallet Adjustment is distinct from a **Rebate** (Commercial Terms-derived shipping allowance credit) and a **Chargeback Clawback** (automated processor-dispute recovery): both remain their own ledger-entry kinds and their own automated posting paths. A Wallet Adjustment is the operator-directed, approval-gated correction path used when neither automated path applies.
- Posted Wallet Adjustments are never edited or deleted; a correction uses a new, linked, opposite-direction Wallet Adjustment, the same pattern the existing `payout-reversal` ledger kind already uses.
- Reason codes are a closed taxonomy: `transaction-correction`, `refund-correction`, `fee-correction`, `dispute-resolution`, `fraud-recovery`, `support-resolution`, `legal-obligation`, `goodwill-cash-credit`, `operational-error`, and `other-with-required-detail` (the only code requiring mandatory free-text explanation).
- Creating or increasing a Negative Balance, a high-value credit or debit, a reversal after the original entry's funds were already spent or paid out, and any self-benefiting target all require elevated, separation-of-duties approval; a self-benefiting target is blocked outright rather than merely elevated.
- The full lifecycle, approval matrix, policy schema, and legacy `workflow`-string retirement decision are recorded in [ADR 0020: Wallet Adjustment Authority And Balance Types](../../docs/adr/0020-wallet-adjustment-authority-and-balance-types.md). The lifecycle, permissions, and typed API are implemented by #4998, #4999, and #5000; this term records the ratified vocabulary ahead of that implementation.

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
