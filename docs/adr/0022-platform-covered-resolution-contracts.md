# ADR 0022: Platform-Covered Resolution Ownership and Contracts

## Status

Accepted for issue #5212 (epic #5210, Wave 2 — Core Commerce Beta Readiness).

This ADR defines vocabulary, ownership, and versioned cross-context contracts only.
It is the gate that precedes the implementation leaves #5213 (Support remedy
execution lifecycle), #5214 (Settlement ProtectionCoverage accounting), #5215
(Payments refund causation), and #5220 (Settlement liability allocation and hold
reconciliation). No provider refund, ledger mutation, operator UI, reverse-shipment
persistence, or data backfill is decided here. It preserves the Settlement
financial-truth boundary established by ADR 0013 and ADR 0020, and it reuses — never
reinvents — the wallet-adjustment correction pattern from ADR 0020.

## Context

Today a support refund is treated as equivalent to seller liability. Settlement's
payment-source projection calls seller refund-debit behavior for every
`payments.payment-refunded` fact, so a marketplace-funded goodwill refund is
financially indistinguishable from seller fault. The protection reserve records only
contribution and reversal facts; it cannot be reserved against or consumed for a
specific case. Support models the adjudication decision and case closure more strongly
than execution completion, so a case can become terminal before refund, ledger, and
physical effects are reconciled. The existing `fulfillment.shipment.returned` terminal
state is an outbound shipment reaching "returned"; it is not a buyer-to-platform
reverse shipment.

Epic #5210 introduces a first-class **Platform-Covered Resolution**: when the
marketplace cannot assign fault with confidence but chooses to make the buyer whole,
it funds the remedy from the protection reserve, never debits the seller incorrectly,
and keeps the case open until every required financial and physical effect is
reconciled. For that to work without hidden coupling, the four decisions an operator
makes must be modeled independently and every implementing context must share the same
ubiquitous language and stable identifiers.

## Decision

### The four orthogonal decisions

An authorized operator selects these four dimensions **independently**. No dimension is
encoded as a special case of another, and "platform covered" is never a single refund
type that collapses them.

1. **Buyer remedy** (`BuyerRemedy`) — what the buyer receives: `full-refund` or
   `partial-refund` today; `replacement`/other future remedies are reserved and will
   carry their own non-monetary shape. A remedy is a positive monetary amount in an
   explicit currency.
2. **Liability allocation** (`LiabilityAllocation`) — who funds it: a `sellerFundedAmount`
   plus a `platformFundedAmount`, both non-negative, in the remedy currency, summing
   exactly to the remedy. A derived, closed `fundingKind` (`seller-funded` |
   `platform-funded` | `split`) lets consumers branch without parsing free-form text.
3. **Return disposition** (`ReturnDirective`) — where the goods go: `return-to-seller` |
   `return-to-platform` | `no-return`.
4. **Refund trigger** (`RefundTrigger`) — when the refund releases: `immediate` |
   `carrier-accepted` | `delivered` | `facility-intake` | `operator-release`.

Two invariants keep the dimensions from silently coupling: **platform coverage is not
synonymous with return-to-platform** (a platform-funded remedy may still return to the
seller, or nowhere), and **return destination is not synonymous with refund timing** (a
`return-to-platform` disposition can pair with any trigger).

### Canonical ownership

- **Platform Operations / Support** owns evidence, adjudication, the buyer remedy, the
  coverage-authorization request, operator permissions, and the case-level remedy
  execution lifecycle and closure policy. It publishes `support.support-request.*`
  facts. It owns `remedyId` and `supportRequestId`.
- **Settlement** owns liability allocation authority, protection-reserve availability
  and consumption, seller ledger effects, holds, and reconciliation — i.e. **financial
  truth**. It owns the `ProtectionCoverage` aggregate and `coverageId`, and publishes
  `settlement.protection-coverage.*` facts. Support requests coverage; Settlement
  decides whether it can be reserved and consumed.
- **Payments** owns the original-rail refund and idempotent provider execution. It owns
  `refundId`. It carries remedy/coverage/allocation references through, but never
  decides who pays.
- **Fulfillment** owns any reverse shipment and physical delivery/intake facts
  (`returnShipmentId`), delivered by the sibling reverse-logistics epic #5211.

Deployables remain thin composition roots. Cross-context integration uses the versioned
facts below, never direct database access.

### Stable identifiers

| Identifier | Type / prefix | Owner | Notes |
| --- | --- | --- | --- |
| `supportRequestId` | `SupportRequestId` (`sup_`) | Support | Existing case id. |
| `remedyId` | `RemedyId` (`rmd_`) | Support | New. The **cross-context correlation anchor**; the same remedy id threads Support, Settlement, Payments, Fulfillment. |
| `coverageId` | `CoverageId` (`cov_`) | Settlement | New. One reservation, belonging to exactly one remedy. Present iff the platform-funded component is positive. |
| `returnShipmentId` | opaque string (Fulfillment) | Fulfillment | Optional; shape owned by #5211, referenced here as an opaque handle so no reverse-shipment model is presupposed. |
| `refundId` | `RefundId` (`rfd_`) | Payments | Referenced as an opaque string on cross-context facts; Payments owns its brand. |

`remedyId` and `coverageId` are the only new stable ids added to shared primitives
(`contracts/primitives/typed-ids.ts`). `refundId` and `returnShipmentId` remain owned
by their contexts and cross the boundary as opaque strings so this contract does not
presuppose Payments' or Fulfillment's internal shapes.

### Envelope semantics — correlation, causation, actor, policy, reason, idempotency

Every published platform-coverage fact carries a shared envelope
(`PlatformCoverageFactEnvelopeV1`):

- **Correlation** — `remedyId` is the correlation key across all four contexts; the
  transport envelope's `trace` block still carries the ambient trace id.
- **Causation** — `causationId` names the fact or command that caused this one; `null`
  on an originating authorization. This makes out-of-order lineage explicit rather than
  inferred from arrival order.
- **Actor** — the acting operator is the transport envelope's `audit.performedByUserId`;
  it is **not** duplicated in the payload. Operator overrides remain append-only,
  reasoned, and auditable through their own facts.
- **Policy version** — `policyVersion` pins the coverage/remedy policy in force so
  replay is deterministic.
- **Reason code** — coverage rejection uses a **closed** `CoverageRejectionReasonCode`
  taxonomy (`insufficient-reserve`, `policy-limit-exceeded`, `currency-mismatch`,
  `conflicting-terms`, `coverage-expired`). Operator authorization reasons are a
  structured `reasonCode` string for audit and are never a funding signal.
- **Idempotency** — `idempotencyKey` makes duplicate delivery a no-op: a consumer that
  has applied a key ignores redelivery. Payments derives its refund idempotency key
  from stable domain ids (remedy/coverage), not request timing (see #5215); Settlement
  keys reservation and consumption by `coverageId` (see #5214).

### Fact catalog

Seven versioned facts, ratified from the issue's candidates. All use the `.v1` suffix,
matching the native-event versioning precedent set by ADR 0021, and additionally carry
`factSchemaVersion: 1` in the payload so decode-time validation is version-aware even
though this codebase has no event-envelope schema-version field. Payload types and
runtime validators live at the smallest existing shared boundary: value objects and
vocabularies in `@chase-sets/primitives/platform-coverage`, fact payloads plus
`normalize*` validators in `@chase-sets/event-core/platform-coverage-facts`, and the
name→payload registry in `@chase-sets/event-core/public-event-payloads`. No new
"support contracts" package was created.

| Fact | Publisher | Consumers | Meaning |
| --- | --- | --- | --- |
| `support.support-request.remedy-authorized.v1` | Support | Settlement, Payments, read models | An operator authorized a remedy (buyer remedy + allocation + return directive + refund trigger). Carries `coverageId` iff platform-funded. |
| `support.support-request.platform-coverage-requested.v1` | Support | Settlement | Support asks Settlement to reserve the platform-funded amount for `coverageId`. |
| `settlement.protection-coverage.reserved.v1` | Settlement | Support | Settlement reserved the requested amount; refund release may proceed. |
| `settlement.protection-coverage.rejected.v1` | Settlement | Support | Settlement refused the reservation with a closed reason code; the case stays open and actionable. |
| `support.support-request.refund-released.v1` | Support | Payments | The refund trigger fired; Payments should execute a refund whose allocation is carried, not inferred. |
| `settlement.protection-coverage.settled.v1` | Settlement | Support | Settlement consumed the reservation and posted allocations against the correlated `refundId`; reconciliation is durable. |
| `support.support-request.remedy-completed.v1` | Support | read models, auto-close timer | Every required remedy effect is terminal and reconciled; only now may closure timers start. |

`support.support-request.refund-released.v1` is the remedy-scoped generalization of the
existing return-specific `support.support-request.return-refund-released` fact; the
legacy fact is not rerouted here (out of scope), but new remedy execution uses the
versioned fact.

### Event flow

Immediate, fully platform-funded refund:

```
Operator ─▶ Support: remedy-authorized.v1 (allocation: platform-funded, trigger: immediate, coverageId)
Support  ─▶ Settlement: platform-coverage-requested.v1 (coverageId, requestedAmount)
Settlement ─▶ Support: protection-coverage.reserved.v1        (or rejected.v1 → case stays open)
Support  ─▶ Payments: refund-released.v1 (allocation, refundAmount)
Payments ─▶ (payments.payment-refunded → refundId)            [#5215]
Settlement ─▶ Support: protection-coverage.settled.v1 (consumes platform portion, refundId)
Support: remedy-completed.v1 → hold release + auto-close timer starts
```

Return-gated refund (`refund trigger = facility-intake`, `return-to-platform`):

```
Support: remedy-authorized.v1 (trigger: facility-intake, return-to-platform)
Support ─▶ Settlement: platform-coverage-requested.v1 ; Settlement: reserved.v1
… wait for Fulfillment reverse-shipment facility-intake fact [#5211] …
Support ─▶ Payments: refund-released.v1  (only after the configured intake fact)
Settlement: protection-coverage.settled.v1 ; Support: remedy-completed.v1
```

### Versioning and replay behavior

- **Version in the name** (`.v1`) plus **`factSchemaVersion` in the payload**. Facts
  evolve **additively** within v1: new fields are optional and default to a documented
  legacy value on decode (e.g. an omitted `causationId` decodes to `null`). A breaking
  change mints a `.v2` type with an explicit upcaster; older events remain replayable.
- **Replay** re-runs the same `normalize*` validator that runs on publish, and money
  amounts are re-canonicalized through the money primitive, so a replayed event
  validates identically to a freshly published one.
- **Duplicate delivery** is harmless: consumers key on `idempotencyKey` (and the stable
  ids), applying an already-seen fact zero times beyond the first.
- **Out-of-order delivery** converges: `causationId` gives explicit lineage, and remedy
  state is projected from correlated facts rather than arrival order. A `reserved`/
  `settled` seen before its request is deferred or reconciled, never dropped.
- **Partial failure** fails closed and visibly. A rejected or expired reservation leaves
  the case open and operator-actionable; a refund that cannot be reconciled to an
  allocation is quarantined for review (#5220), never silently charged to the seller.
  Unknown fact types surface rather than being dropped, so deploy skew fails loudly.

### Invariants encoded in the contract

- Currency is explicit; all money uses the repository money primitive.
- Allocation components are non-negative and sum exactly to the authorized remedy
  (`normalizeLiabilityAllocationForRemedy`).
- A `coverageId` accompanies a remedy fact **iff** the platform-funded amount is positive
  — platform coverage is never free-form, and a coverage id belongs to exactly one
  remedy (`reconcileCoverageId`).
- A refund-released allocation sums to the released refund amount.
- Consumers distinguish seller-funded, platform-funded, and split allocations via the
  derived closed `fundingKind`, never by parsing text.
- Personally identifying facility/address data is absent from these public facts; only
  ids, amounts, currency, and closed enums cross the boundary.

## Alternatives considered

- **Refund "reason" metadata only.** Encode coverage as free-text on the refund. Rejected:
  it forces every consumer to parse and trust unstructured strings, which may be truncated
  or absent on replay; it cannot express a split allocation; and it leaves Settlement
  inferring liability from text — exactly the coupling this epic removes.
- **Support-owned financial allocation.** Let Support post seller/platform amounts.
  Rejected: it moves financial truth out of Settlement, violating ADR 0013/0020, and
  duplicates ledger and reserve logic in a context that should own adjudication, not
  double-entry accounting.
- **Wallet adjustment as the primary path.** Fund every platform-covered refund with a
  wallet adjustment. Rejected: ADR 0020 defines wallet adjustments as a governed
  **correction** mechanism, not sale/settlement flow. Using them as the primary record
  loses the reservation/consumption lifecycle, over-authorization protection, and
  reserve reconciliation, and conflates a cash-equivalent correction with normal
  settlement. Wallet adjustment remains available only as an explicit, correlated
  correction path (#5220), consistent with ADR 0020.
- **A single `platform-covered-refund` special case.** One refund type meaning "platform
  paid." Rejected: it collapses the four orthogonal decisions, cannot represent split
  funding or a return-gated trigger, and reintroduces the "refund implies liability"
  assumption. The orthogonal model above is strictly more expressive with the same or
  fewer facts.

## Consequences

- #5213–#5215 and #5220 consume one authoritative contract; fact names, payload shapes,
  and the allocation invariant are fixed here and stay replay-stable.
- Settlement gains a real `ProtectionCoverage` aggregate boundary (`coverageId`) to build
  in #5214; Support gains a `remedyId`-anchored execution lifecycle in #5213; Payments
  carries causation in #5215; Settlement allocates without unconditional seller debits in
  #5220.
- The new fact names are the canonical vocabulary linked from epics #5210 and #5211.
- Context READMEs (Platform Operations, Settlement, Payments, Fulfillment) record the
  published/consumed facts and must not carry a competing ownership statement.
