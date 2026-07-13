# ADR 0020: Wallet Adjustment Authority And Balance Types

## Status

Accepted for milestone epic #4993 (issue #4997).

Depends on #4996 (P0, open) closing the arbitrary-account authorization exploit before any implementation of this decision may post live traffic. This ADR may be, and is, drafted and ratified before #4996 closes; it is not a license to enable posting early. Implementation (#4998, #4999), platform-admin authorization (#5000), and the counsel-approved Terms of Service update (#5004) are separate, later issues; each references this ADR as the canonical vocabulary and is out of scope here.

## Context

`bounded-contexts/settlement/features/wallets/api/route.ts` exposes `POST /wallet/adjustments`, `/wallet/refund-debits`, `/wallet/dispute-holds`, and `/wallet/dispute-releases` under the account-scoped `payouts.manage` permission. `POST /wallet/adjustments` infers both the ledger `direction` and `kind` from a client-supplied free-text `workflow` field (`workflow === "dispute-release"` selects `credit`; `workflow === "seller-refund-debit"` selects the `refund` kind; everything else defaults to a `debit`/`adjustment`). The audit reason is folded into the ledger entry's free-text `description` rather than recorded as a structured, closed-taxonomy fact. All four routes call the same `postOperatorWalletEntry` helper, which in turn issues the generic `PostLedgerEntry` command defined in `bounded-contexts/settlement/features/wallets/domain/domain.ts`.

Epic #4993 identifies this as an authorization inversion: account owners/managers hold `payouts.manage` and can target an arbitrary `accountId`, so `workflow=dispute-release` becomes an immediately available self-credit path. #4996 (P0, still open at the time of this decision) closes that immediate exploit by scoping target-account and permission checks. #4996 does not, and is not intended to, resolve the deeper vocabulary and control gaps: there is no request/approve/reject/reverse lifecycle, no closed reason-code taxonomy, no negative-balance or high-value approval policy, and no distinction recorded anywhere between this cash-equivalent correction and a future non-withdrawable promotional credit (#4891).

Settlement's `LedgerEntryKind` already includes an `"adjustment"` value (`bounded-contexts/settlement/support/runtime-support/common.ts`), and the `PostLedgerEntry` decider already enforces the core balance invariant relevant here: an ordinary `debit` against `available` funds cannot exceed `state.availableBalanceAmount` unless the command explicitly sets `allowNegativeBalance: true` (`decideWallet`, `bounded-contexts/settlement/features/wallets/domain/domain.ts`). The existing `payout-reversal` ledger kind and `settlement.wallet.negative-balance-entered` / `-recovered` / `-collections-opened` events establish two precedents this decision reuses rather than reinvents: corrections are modeled as new, opposite-direction ledger entries linked to the original (never edits/deletes), and negative-balance state is a first-class, evented Wallet fact.

This decision must resolve before #4998 (lifecycle), #5000 (permissions and controls), and #5004 (counsel-approved Terms) can proceed; all three are blocked on it in the epic's dependency graph.

## Decision

### Definition

A **Wallet Adjustment** is a Settlement-owned, cash-equivalent correction to an account's wallet balance, requested by an authorized platform operator, approved by a separate authorized platform operator, and posted as exactly one immutable `adjustment`-kind Wallet Ledger Entry. A Wallet Adjustment is not a new balance type: it is a governed, auditable *path* onto the existing available/pending Wallet balance that the `PostLedgerEntry` decider already enforces.

An **available adjustment credit** is ordinary available wallet balance. It is spendable against `platform-purchase` debits and payoutable under the same payout-readiness and clearance rules as any other available balance (`bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts`, `funds-hold-policy.ts`). This ADR does not create a second, adjustment-specific clearance window. An adjustment credit posts with `fundsStatus: "available"` by default, because it is an already-approved correction rather than new unclearanced sale proceeds; a future implementation slice may choose `"pending"` for a specific reason code only with documented evidence that the risk profile warrants it. Per the existing Wallet invariant, an available adjustment credit offsets a Negative Balance before any remainder becomes payout-eligible, the same as sale proceeds and shipping allowances (Settlement `GLOSSARY.md`, Negative Balance notes).

### Distinguished from Marketplace Credit

A Wallet Adjustment is always cash-equivalent: spendable, payoutable, and part of the one available-balance number Settlement reports. **Marketplace Credit** is a distinct, not-yet-built capability owned by #4891 (Wallet billing / capability-usage program): promotional or prepaid, non-withdrawable, usage-scoped value. Marketplace Credit:

- must not share the Wallet Adjustment command, lifecycle, or reason-code taxonomy defined by this ADR;
- must not be summed into `availableBalanceAmount` as though it were payoutable cash;
- gets its own ledger-entry kind(s) and its own Settlement (or future-owning-context) glossary terms when #4891 is scoped — it does not reuse `"adjustment"`.

This ADR does not design Marketplace Credit. It records the boundary so #4891 does not collapse the two concepts, and so #5004's counsel review has a settled distinction to describe.

### Immutability and reversal

Posted Wallet Adjustments, like all Settlement ledger entries, are never edited or deleted. A correction to a posted Wallet Adjustment is a new, linked, opposite-direction Wallet Adjustment referencing the original — the same pattern the existing `payout-reversal` ledger kind and chargeback-clawback release already use. The reversal preserves both entries and restores the balance the original entry would have left had it never posted.

### Reason codes (closed taxonomy)

A Wallet Adjustment must carry exactly one of the following reason codes. This is a closed set; extending it requires a new ADR revision, not an ad hoc string.

| Reason code | Meaning |
| --- | --- |
| `transaction-correction` | General correction to a mis-posted ledger fact not covered by a more specific code below. |
| `refund-correction` | Wallet-side correction that supplements or corrects the wallet consequence of a Payments-owned Refund (Payments `GLOSSARY.md`); does not itself reverse the external payment rail transaction. |
| `fee-correction` | Correction to a previously posted `fee`, `authenticity-fee`, or `rebate` ledger consequence. |
| `dispute-resolution` | Outcome of a processor dispute investigation (Payments `Payment Disputed`) not already fully resolved by the automated Chargeback Clawback path. |
| `fraud-recovery` | Recovery of confirmed fraud loss. |
| `support-resolution` | Remedy directed by a Platform Operations support case, bounded by the existing Affected Line Item Amount Contract. |
| `legal-obligation` | Correction required by a court order, regulator directive, or other legal mandate. |
| `goodwill-cash-credit` | Discretionary customer-goodwill credit. Still cash-equivalent; never a substitute for a future Marketplace Credit grant. |
| `operational-error` | Internal platform operational mistake, such as a mis-keyed manual entry or a batch-job defect. |
| `other-with-required-detail` | Catch-all. The only reason code where a mandatory free-text explanation is required in addition to the code; every other code may carry optional free-text detail but must not depend on it for its meaning. |

Recording the reason as a structured code (rather than folding it into the ledger entry's free-text `description`, as the current `auditReason` parameter does) is itself part of this decision — see Compatibility and Retirement below.

### Lifecycle

A Wallet Adjustment moves through five states, each a command/event pair implemented by #4998:

1. **Requested** — an authorized operator submits target account, direction, amount, currency, reason code, explanation, and evidence references. Not yet a balance effect.
2. **Approved** — a *different* authorized operator approves the request. Self-approval is never permitted.
3. **Rejected** — a different authorized operator declines the request. Terminal; a new request is required to retry.
4. **Posted** — approval triggers exactly one `PostLedgerEntry` command against the Wallet aggregate with `kind: "adjustment"`, producing the existing `settlement.wallet.ledger-entry-posted` event. A retry of an already-posted adjustment returns the existing result; it never posts twice.
5. **Reversed** — a new, opposite-direction Wallet Adjustment linked to the original. Reversal after the original credit has already been spent or paid out is itself a high-risk action (see Approval Matrix) because it can drive the balance negative.

### Negative balance and approval matrix

Ordinary debits obey the existing Wallet invariant unchanged: a debit cannot exceed available balance unless the command explicitly allows a negative balance. For Wallet Adjustments, creating or increasing a negative balance is never an ordinary action:

| Action class | Requester ≠ approver | Recent authentication | Elevated (second, distinct) approval |
| --- | --- | --- | --- |
| Ordinary request/approve (any reason code, below both high-value thresholds, does not touch negative balance) | Required | Required at request, approval, and reversal | Not required |
| High-value credit or debit (at or above the platform-policy threshold) | Required | Required | Required |
| Creating or increasing a negative balance | Required | Required | Required, always — no threshold exemption |
| Reversal after the original entry's funds have already been spent or paid out | Required | Required | Required |
| Self-benefiting (target account is the requester's, the approver's, or an account under their common control per Identity) | N/A | N/A | **Blocked outright.** Not merely elevated; there is no in-lifecycle override. |

"Elevated approval" means a second platform-admin approver, distinct from both the requester and the primary approver, and distinct from the ordinary single-approver path. This table is the authorization *policy*; #5000 implements it against the concrete permissions it names (`wallet-adjustments.view`, `wallet-adjustments.create`, `wallet-adjustments.approve`, `wallet-adjustments.reverse`) and the recent-authentication mechanism already owned by Auth's session semantics — this ADR does not invent a new Settlement-owned session concept.

### Policy inputs and conservative defaults

The concrete threshold numbers are Settlement-owned platform policy (`infrastructure/platform-policy/define-policy.ts`, the same machinery as `settlementClearancePolicy`), not literals embedded in UI or in a deployable. This ADR fixes the schema shape and a conservative compiled default for #4998/#5000 to implement as `settlement.wallet-adjustment-controls`:

```
{
  highValueCreditThresholdAmount: string  // default "500.00"
  highValueDebitThresholdAmount: string   // default "500.00"
  recentAuthMaxAgeMinutes: integer        // default 15
}
```

Negative-balance elevation, reversal-after-spend elevation, and the self-benefiting block are not threshold-gated — they apply unconditionally per the approval matrix above, so they are policy-independent booleans, not part of the numeric schema. An operator can revise the two dollar thresholds and the recent-auth window without a deploy, with the usual policy audit history; the compiled default above is the single source used until an operator revises it, matching the existing `settlementClearancePolicy` convention.

Domain events snapshot the resolved decision: each `settlement.wallet-adjustment.*` event records the policy values that governed that specific request/approval/reversal (threshold amounts, recent-auth outcome, elevation requirement) at the time of the decision, so a later policy revision never reinterprets a historical adjustment's authorization basis.

### Command, event, and API vocabulary

Commands (Settlement-internal, new `WalletAdjustment` aggregate, typed `WalletAdjustmentId`): `RequestWalletAdjustment`, `ApproveWalletAdjustment`, `RejectWalletAdjustment`, `PostWalletAdjustment`, `ReverseWalletAdjustment`.

Events (Settlement-internal facts, `settlement.wallet-adjustment.*` stream, distinct from the existing `settlement.wallet.*` Wallet aggregate stream): `settlement.wallet-adjustment.requested`, `settlement.wallet-adjustment.approved`, `settlement.wallet-adjustment.rejected`, `settlement.wallet-adjustment.posted`, `settlement.wallet-adjustment.reversed`. These are internal Settlement facts, not new outgoing integration events — no other bounded context needs the adjustment lifecycle's internal request/approval detail.

The one cross-context-visible fact is unchanged in shape and already published: the existing `settlement.wallet.ledger-entry-posted` event and the `LedgerEntryPosted` / `AccountBalanceUpdated` integration events already listed in Settlement's README, now including postings whose `kind` is `"adjustment"` and whose posting was authorized through this lifecycle rather than the legacy `workflow` string. This ADR adds no new outgoing integration event and places no adjustment behavior in a deployable; Settlement remains the sole owner of the lifecycle, the ledger effect, and the read model.

Behavior owner: **Settlement**. Authorization facts (permission grants, recent-authentication state): **Auth/Identity**, consumed by Settlement at the API boundary, per the existing Settlement `context.json` `allowedContextDependencies`.

## Alternatives Considered

### Reuse the generic `PostLedgerEntry` command directly (status quo)

Rejected. This is the current state and is the mechanism #4996 must partially fence off as a security exploit: no request/approve/reject/reverse lifecycle, no closed reason-code taxonomy (the audit reason is free text folded into `description`), no negative-balance or high-value approval policy, and direction/kind inferred from an untyped `workflow` string. `PostLedgerEntry` remains the correct low-level Wallet command for posting the *ledger effect* of an approved adjustment — this ADR does not remove it — but it is not itself a governance boundary and must not be exposed as one to operator-facing callers.

### A separate Wallet Adjustment lifecycle inside Settlement, posting through the existing Wallet ledger on approval (selected)

Adopted. This keeps Settlement as the sole financial-truth owner (epic #4993's stated invariant) while adding the missing governance layer: typed request/approve/reject/reverse states, a closed reason-code taxonomy, and a policy-driven approval matrix. Because the lifecycle still ends in exactly one ordinary `PostLedgerEntry` call, all existing negative-balance, collections, clearance, and payout-readiness machinery keeps working unmodified — there is no second balance model to keep in sync with the first.

### Platform Operations ownership

Rejected. Platform Operations owns policy documents, moderation, trust queues, and support workflows, not financial-truth ledger state. Moving wallet-balance-affecting behavior there would violate Settlement's stated invariant ("Settlement is the source of truth for what the marketplace owes or is owed," Settlement `README.md`) and directly contradicts epic #4993's explicit non-goal: "Moving financial behavior into Platform Operations, Identity, Commercial Terms, or deployables." Platform Operations may still *originate* a `support-resolution`-coded request (an operator acting from a support case), but Settlement approves and posts it.

## Non-Goals

- Implementing the lifecycle commands, events, aggregate, persistence, or read model (#4998).
- Exposing typed preview/command/admin query APIs (#4999).
- Implementing the platform-admin permissions, recent-authentication enforcement, or the `settlement.wallet-adjustment-controls` policy document code (#5000).
- Closing the immediate arbitrary-account authorization exploit on the legacy routes (#4996) — that is a P0 security fix that must land regardless of this ADR's timing, and this ADR does not relax it.
- Designing Marketplace Credit (#4891).
- Publishing counsel-approved Terms of Service language (#5004). Decision #5004 is operator-gated on qualified legal counsel and is explicitly out of scope for this issue; this ADR is the "ratified Settlement ADR" #5004 is required to treat as product truth, but counsel review itself is not performed here.
- Mutating any historical ledger entry.

## Compatibility And Retirement: The Legacy `workflow`-String Route

`POST /wallet/adjustments`'s `workflow`-string branch (`workflow === "dispute-release"` / `"seller-refund-debit"` / anything else) is a short-lived compatibility shim, not the permanent Wallet Adjustment API surface. It is retired once #4998 ships the typed lifecycle and #4999 exposes the typed request/approve/reject/reverse API — callers migrate to the typed commands, and the `workflow`-string branch is deleted rather than kept as a second, parallel posting path.

`/wallet/refund-debits`, `/wallet/dispute-holds`, and `/wallet/dispute-releases` are narrower, single-purpose routes already scoped to specific automated integrations (per epic #4993: "existing automated refund/dispute behavior remains available only through appropriately scoped service authority"). They are not renamed to Wallet Adjustment and do not become the general operator adjustment path; #4996 is responsible for closing their target-account/permission exposure without collapsing them into the generic route. Whether they are eventually re-implemented on top of the typed lifecycle (as an internal caller of `RequestWalletAdjustment`/`ApproveWalletAdjustment` with a fixed reason code) or remain a distinct narrow path is left to #4998/#4999 to decide with the ratified vocabulary in hand; either way, they never again infer direction from an untyped string.

Removal of the legacy `workflow`-string branch is tracked as in-scope follow-up work under #4998/#4999, not performed by this documentation-only issue.

## Guardrails

This decision adds no new automated structure guard. The existing `check:structure` glossary-coverage guard and `business-literal-guard.mjs` already apply once #4998 adds `wallet-adjustment` as an owned noun to Settlement's `context.json` and #5000 adds the `settlement.wallet-adjustment-controls` policy file — no separate enforcement mechanism is introduced here.

## Reopening Criteria

Revisit this ADR before:

- #4891 (Marketplace Credit) needs to share more machinery with Wallet Adjustment than the boundary recorded here allows;
- #5004 counsel review surfaces a jurisdictional requirement (money transmission, stored value, unclaimed property) that changes the negative-balance, reversal, or reason-code model rather than merely the published Terms copy;
- evidence from #4998/#5000 implementation shows the fixed `$500.00` / 15-minute conservative defaults are operationally wrong before an operator has revised the policy;
- a future reason code is genuinely needed — this requires a new ADR revision, not an unreviewed taxonomy extension.

## Consequences

#4998 can implement the lifecycle against a single canonical vocabulary instead of re-deriving direction/kind semantics from route names. #5000 can name and scope exactly four permissions and one recent-authentication requirement instead of inferring them from `payouts.manage`. #5004's counsel review has a settled cash-equivalent-vs-Marketplace-Credit boundary and a concrete authority/reason-code list to describe in the Terms rather than summary-only copy. The legacy `workflow`-string branch has a named retirement condition instead of becoming permanent by default.
