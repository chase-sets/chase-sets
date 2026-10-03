# ADR 0032: Order Groups And Shipment Groups

## Status

Proposed for #6462, under #6461's authorship handoff. Independent exact-head review
ratifies these decisions. Host decision 6462-hq-decision-r1 settles destination correction, catalog completeness and evidence-window reachability. Todd settled Survivor Shipping-shortfall funding at https://github.com/chase-sets/chase-sets/issues/6462#issuecomment-5972382100. This ADR does not ship grouping.

V1 contains exactly an existing anchor Order and one follow-on Order. It preserves
the [#6460 ruling](https://github.com/chase-sets/chase-sets/issues/6460#issuecomment-5170328894)
and [#7196 option A](https://github.com/chase-sets/chase-sets/issues/7196#issuecomment-5375382809).
The exact admission protocol is [#7197](https://github.com/chase-sets/chase-sets/issues/7197),
the Shipment authority is [#7198](https://github.com/chase-sets/chase-sets/issues/7198),
and quote/formation execution belongs to [#7200](https://github.com/chase-sets/chase-sets/issues/7200).
These replace #6463, not this ADR. Physical execution needs the repaired #6464 brief.

## Context and ownership

Ordering owns commercial linkage; Fulfillment owns admission, packing, labels, and
tracking. Payments owns per-Order payment/refund execution and Settlement owns
financial truth. Deployables only compose ports and workers. No context reads
another context's tables to establish authority.

The current quote path is `quotePlan` in
`bounded-contexts/ordering/features/orders/api/runtime.ts`; it builds a package plan,
calls `ShippingQuotePolicy.quote`, and snapshots
`calculateOrderFulfillmentEconomics` from
`bounded-contexts/ordering/features/orders/domain/policies.ts`.
Fulfillment's `purchaseUspsLabel` in
`bounded-contexts/fulfillment/features/shipments/api/runtime.ts` consumes one
Shipment's committed plan. Buy and void use the postage-operation paths, not
`executeShipmentAction`. None of these current paths implements grouping.

### Identities

| Identity | Owner and authority | Meaning |
| --- | --- | --- |
| `OrderGroupId`, `ogr_` | Ordering; anchor Order stream | Immutable exact-two commercial linkage. The admission payload's `groupId` has this type. |
| `ShipmentGroupId`, `shg_` | Fulfillment; physical execution linked to anchor Shipment authority | One physical execution identity for that admitted pair; allocated once after committed admission and retained on replay. Never substituted for wire `groupId`. |
| `anchorOrderId`, `ord_` | Ordering | The already committed first Order, never an arbitrary minimum ID or the latest member. |
| `anchorShipmentId`, `shp_` | Fulfillment | The first Order's eligible Shipment; serializes admission against packing and cancellation. |
| Follow-on Order/Shipment | Their existing owners | Retain independent IDs, streams, money, refund caps, and member lifecycle. |

Use existing `createId` and `parseStrictTypedUlid` for new IDs. Do not tighten the
permissive `parseTypedId` or change unrelated persisted identifiers. Distinct group
prefixes prevent confusing commercial linkage with physical authority. IDs do not
encode cardinality, money, addresses, or provider identity.

The anchor Order stream owns group formation, membership removal and dissolution;
there is no second Ordering group aggregate competing with that stream. Fulfillment
records the physical group binding and disposition on the anchor Shipment stream;
the Shipment Group ID does not create a competing admission aggregate. Member
Shipment effects carry that binding and causal version. A rebuilt or lagging group
row is never authority to allocate another ID or label.

## Admission contract

### Exact port and payloads

The planned shared boundary owned by #7197 exports shapes, not orchestration:

```ts
interface ShipmentGroupAdmissionAuthority {
  reserve(input: AdmissionIdentity, context: EventStoreContext): Promise<ReserveResult>;
  commit(input: AdmissionIdentity & { anchorOrderVersion: number }, context: EventStoreContext): Promise<CommitResult>;
  abort(input: AdmissionIdentity & { reason: AbortReason }, context: EventStoreContext): Promise<AbortResult>;
}
```

`I` below is the full required replay tuple: `requestId`, `sourceGeneration`,
`draftKey`, `anchorShipmentId`, `anchorOrderId`, `proposedMemberOrderId`, `groupId`,
`quoteFingerprint`. There is no caller timestamp. `memberOrderIds` is ordered
anchor then follow-on, two distinct Orders matching `I`.

`R` is `requestId`, `groupId`, `anchorOrderId`, `anchorShipmentId`,
`memberOrderIds` (the exact-two ORIGINAL members), `removedOrderId`, `reason`,
`anchorOrderVersion`. Removal does not rewrite the original pair to a singleton.

Abort reasons are exactly `quote-stale | reservation-rejected | capacity-rejected |
stage-failed | cancelled | compensating`.

Removal/dissolution reasons are exactly `buyer-cancelled | seller-cancelled | support-cancel-order | seller-cannot-fulfill | payment-deadline | inventory-unavailable | fraud | compensating`.

A removal reason is always the target's own `ordering.order.cancelled` reason. The catalog is the closed set of cancellation reasons that can reach a current group member. The current producers are:
- `buyer-cancelled` and `seller-cancelled`: the buyer and seller cancel paths in Ordering runtime.
- `payment-deadline`: the deadline sweep.
- `inventory-unavailable`: reservation rejection.
- `support-cancel-order` and `seller-cannot-fulfill`: `support-cancellation-reaction.ts`.

`fraud` and `compensating` are planned. `seller-cannot-fulfill` extends the #7197 brief's list by host decision, and #7197 reproduces it. A new producer that can reach a group member must extend this catalog by contract change before it ships.

All nine facts require `contractVersion: "order-group-admission/v1"`. These are
the exact names, without `.v1` aliases, `member-added`, or another group namespace.
Each row lists every payload field beyond `contractVersion`.

| Fact | Required fields | Publisher | Consumers |
| --- | --- | --- | --- |
| `ordering.order-group.admission-requested` | I, `requestedAt`, `anchorOrderVersion` | Ordering | Fulfillment reserve; Ordering recovery/read models |
| `ordering.order-group.admission-aborted` | I, `reason` (Abort), `abortedAt`, `anchorOrderVersion` | Ordering | Fulfillment pre-Form release; Ordering recovery/read models |
| `ordering.order-group.formed` | I, `memberOrderIds`, `formedAt`, `anchorOrderVersion`, `stagedMemberOrderVersion` | Ordering | Fulfillment commit; Ordering recovery/read models |
| `ordering.order-group.member-removed` | R, `removedAt` | Ordering | Fulfillment validation/telemetry; Ordering recovery/read models |
| `ordering.order-group.dissolved` | R, `dissolvedAt` | Ordering | Fulfillment committed release; Ordering recovery/read models |
| `fulfillment.shipment-group.admission-reserved` | I, `reservedAt`, `shipmentVersion` | Fulfillment | Ordering staging coordinator/read models |
| `fulfillment.shipment-group.admission-rejected` | I, `reason` (`packing-started/cancelled/already-grouped/identity-conflict`), `rejectedAt`, `shipmentVersion` | Fulfillment | Ordering compensation/review/read models |
| `fulfillment.shipment-group.admission-committed` | I, `anchorOrderVersion`, `committedAt`, `shipmentVersion` | Fulfillment | Ordering activation/recovery; Fulfillment physical execution/read models |
| `fulfillment.shipment-group.admission-released` | I, `reason` (`aborted/group-dissolved`), `releasedAt`, `shipmentVersion` | Fulfillment | Ordering recovery/read models; Fulfillment physical execution |

Closed result unions distinguish accepted/replayed results from `packing-started`,
`cancelled`, `already-grouped`, `identity-conflict`, `not-reserved`, and `released`.
These result discriminants do not expand either fact reason union. #7197 codecs
must reject missing, extra or malformed fields recursively, including wrong member
cardinality/identity, noncanonical IDs, wrong contract version, invalid bounds and
instants without timezones. There is no PII or money in these payloads.

### Envelope, concurrency and replay

Reuse [ADR 0022's envelope conventions](./0022-platform-covered-resolution-contracts.md#envelope-semantics--correlation-causation-actor-policy-reason-idempotency),
not its coverage-specific payload fields or `.v1` naming rule. The existing
`contracts/event-core/transport.ts` supplies `id`, `streamId`, `streamVersion`,
`tenantId`, `metadata`, `audit`, `trace`, and `timing`.

- Correlation is `groupId` plus the full admission identity and source generation;
  ambient trace metadata remains transport-owned.
- Causation is recorded in transport `metadata.causationId`, naming the triggering
  command identity or event ID; an originating request has null causation. It is
  not an extra group payload field.
- Actor/account are `audit.performedByUserId` and `audit.forAccountId`, carried
  through worker effects. Tenant and account authorization remain mandatory.
- Policy inputs/versions are frozen in the quote fingerprint and Order/plan
  snapshots; `contractVersion` is schema identity, not commercial policy version.
- Reasons use only the closed unions above. They are audit semantics, not
  implicit permission to charge, refund, correct another Order, or cancel both.
- Consumers rehydrate aggregate identity and version, validate the entire tuple,
  and append at the expected aggregate version. Neither row presence nor seeing
  an event type once proves completion. Source stream identity/version accompanies
  at-least-once delivery; replay reconstructs terminal command outcomes.

### State and command table

| Admission state | Reserve | Commit / formed | Abort / admission-aborted | Packing or cancellation |
| --- | --- | --- | --- | --- |
| available | Reserve only at authoritative awaiting-package, uncancelled, ungrouped Shipment version; otherwise closed rejection | `not-reserved` | `not-reserved`; no release to invent | Packing/cancellation winning first prevents reserve |
| reserved | Same full I replays; same request with any changed field conflicts; another request cannot replace it | Matching I and anchor version commit once | Matching pre-Form I releases once with `aborted` | Packing is retryable busy; cancellation uses pre-Form Abort, or post-Form compensation, never bypasses the admission |
| committed | Same I reports durable committed outcome; another live identity rejects | Duplicate same identity/version replays; conflicting tuple/version rejects | Forbidden, not a release shortcut | Physical behavior under repaired #6464; only dissolved releases, with `group-dissolved` |
| released | Old I is terminal released; new request/generation/group/fingerprint may reserve only an eligible ungrouped awaiting-package anchor | Old I remains terminal, cannot re-commit or mutate a newer reservation | Old I terminal replay, no new release | A stale command cannot affect a new generation; packing/cancellation eligibility still applies |

An early command with a missing durable prerequisite is retried from that
prerequisite, not accepted speculatively. An out-of-order dissolved fact must first
reconstruct its matching formed/committed lineage before release; it never releases
whatever happens to occupy the anchor today. `member-removed` and raw
`ordering.order.cancelled` validate and diagnose group linkage (including explicit
legacy-poison handling), but do not race a second committed-release command.

### Formation and event-only recovery

At confirmation, revalidate same signed-in buyer/seller, standardized origin AND
destination, Shipping option, compatible committed policies, current measures,
uncancelled ungrouped awaiting-package anchor, and a follow-on charge no greater
than standalone. Structural consent ends at packing. Stale inputs return a reviewed
replacement preview before Payment, never a silently changed charge.

Process selected seller groups in ascending `draftKey`: open the source generation
and request on each anchor; reserve ALL admissions before purchase-limit/capacity
claims or proposed Order writes; claim; Stage; Form; Commit; Activate; Payment last.
The staged Order has a complete frozen snapshot but no ordinary public created,
inventory, payment, or query effects, and rejects lifecycle commands other than
Activate/Abandon. Form binds the exact staged member version. Fulfillment committed
drives activation; all selected entries must finish before Payment can start.

| Crash / delivery seam | Worker-only continuation and stable outcome |
| --- | --- |
| Request recorded, direct port absent | Requested fact reserves on the anchor Shipment; reserved fact resumes Ordering. Same I produces the same receipt, not another reservation. |
| Reserved, claims or Stage failed before Form | Ordering emits Abort with the exact cause and releases pre-Form entries in reverse order; staged-only members are abandoned; no Payment. |
| Stage durable, Form response lost | Staged event drives idempotent Form on the anchor at the recorded staged version, then formed drives commit. No second Order. |
| Form durable, commit response lost | Replay formed against matching Shipment I/version; committed fact resumes Activate. Abort is no longer legal. |
| Commit durable, activation response lost | Replay recorded commitment; Activate once on the staged stream; do not infer activation from a projected row or an event-type hit. |
| Later seller-group failure after an earlier Form | Parent becomes `review-required`; Activate any formed staged member idempotently, CancelOrder with `compensating`, then member-removed/dissolved; no Payment while parent is non-created. |
| Cancellation/dissolution delivered out of order | Reconstruct causal versions; dissolved alone releases committed authority. Duplicate raw cancellation/removal does not release again. |
| Successful source retried day after payment, dissolution or cancellation | Terminal `created` source returns the original Order IDs after identity validation; historical admissions are not re-opened. |
| Failed generation retried after replacement preview | N stays immutable terminal; N+1 has new I and independently eligible anchor. A late N fact cannot mutate N+1. |
| Healthy committed group, including the day after delivery | Remains the same exact-two linkage and committed admission. After both Orders are ready, Fulfillment packs, labels, dispatches and tracks the chosen physical disposition. Delivery completes physical work, not a new admission or dissolution. Replayed commands return recorded outcomes; no recurring cleanup or automatic re-grouping. |

The optional in-process port is latency optimization only. The durable requested,
reserved/rejected, formed, committed, aborted/dissolved and released sequence must
work in the worker with no port. No HTTP admission endpoint, caller clock, lease,
periodic sweep, or projection decides admission. Terminal cleanup is driven by
cancellation, void/refund and fraud facts with durable causal retry.

## Money remains per Order

Build a combined plan from CURRENT measures for all lines, including committed
anchor listings whose availability may now be zero. Missing/malformed measures
suppress the offer. The quote call has the exact tuple `sellerAccountId`, common
`shippingOption`, combined `itemSubtotalAmount`, total `quantity`, distinct combined
`listingCount`, and combined `packagePlan`.

Use integer cents: `max(0, combinedQuote.baseAmount - first.shippingBaseAmount)`.
The basis is the first frozen BASE, not its buyer charge, payout, or label cost.
Run existing follow-on economics with that incremental base and the follow-on
subtotal/allowance. Freeze all nine outputs: `shippingBaseAmount`,
`shippingDiscountAmount`, `shippingAllowanceAmount`, `shippingOverageAmount`,
`sellerShippingPayoutAmount`, `protectionAmount`, `protectionAllowanceAmount`,
`protectionOverageAmount`, `shippingChargeAmount`.

The quote fingerprint uses #7200's versioned canonical `order-group-quote/v1`
object, recursively sorted object keys, preserved array order, and SHA-256 of the
UTF-8 `chase-sets:<version>\n` prefix plus canonical JSON. `draftKey` uses the same
algorithm with `order-group-draft-key/v1`. Bind every quote input, measure/package,
policy/version, anchor frozen Shipping input and nine follow-on outputs. Replay
never re-evaluates mutable policies to change committed money.

The following are synthetic arithmetic examples, not provider observations. Vectors
are cents in the nine-field order above; allowance is 100 bps unless noted.

| Case | Combined base / first base | Follow-on subtotal / allowance | Frozen follow-on vector | Result |
| --- | --- | --- | --- | --- |
| 8 - 5 = 3 | 800 / 500 | 1000 / 100 bps | (300, 0, 0, 300, 300, 10, 10, 0, 300) | Buyer Shipping 300; first vector unchanged |
| 4 - 5 clamps to zero | 400 / 500 | 1000 / 100 bps | (0, 0, 0, 0, 0, 10, 10, 0, 0) | No negative price or first-Order refund |
| Nonzero shipping allowance and protection | 800 / 500 | 10000 / 200 bps | (300, 100, 100, 200, 200, 100, 100, 0, 200) | Existing protection-first allowance allocation retained |
| Nonzero protection overage | 800 / 500 | 10000 / 0 bps | (300, 0, 0, 300, 300, 100, 0, 100, 400) | Buyer sees combined Shipping, not another protection fee |
| Worse than standalone | 1100 / 500 | 1000 / 100 bps | candidate (600, 0, 0, 600, 600, 10, 10, 0, 600) | Standalone base/charge 500: refuse offer before reserve/Payment |
| Follow-on cancelled pre-packing | First base 500 stays 500 | Only cancelled member refunds/releases | First's entire committed vector unchanged | Group dissolves; the original anchor ships alone on its own standalone frozen vector; no shortfall arises and no buyer repricing |
| Anchor cancelled pre-packing | Combined 800; survivor incremental base 300 | Survivor standalone quote 500 | Survivor vector unchanged, not raised to 500 | Survivor ships under its own Shipment with its vector unchanged; the standalone-versus-incremental gap follows 'Survivor Shipping shortfall'; a `buyer-cancelled` anchor's refund withholds S = 500 - 300 = 200 per 'Survivor Shipping shortfall' |

Payments, refund caps, fees, Settlement sale accounting, seller capacity, inventory
and purchase-limit usage stay per Order. No consolidation credit, money pooling,
first-money mutation or reassignment of cancelled-member allowance to the survivor. The only exception is the frozen survivor Shipping-shortfall withholding from a `buyer-cancelled` anchor's refund.
Ordinary refunds and inventory/capacity release affect only the cancelled member.

## Postage attribution and policy

### One physical label, one financial lineage

Choose the anchor Shipment as the singular postage subject for combined dispatch:
`PurchaseUspsLabelRequest.subjectKind = "shipment"`, `subjectId = anchorShipmentId`.
The public request in `contracts/postage-labels/index.ts` does not take the former
`orderId`/`shipmentId` fields. Do not add `shipment-group` to that union here.
The group's physical identity scopes the operation but is not a provider subject.

`infrastructure/easypost-postage/index.ts` sends `idempotencyKey` as
`shipment.reference`, mapped sender/recipient/parcel and options. It does not send
subjectKind/subjectId as dedicated provider fields. It creates/rates then buys; a
created-but-not-bought result is distinct from a confirmed purchase.

The anchor owns the single money-bearing `fulfillment.shipment.label-attached`
fact for the actual combined label. Both members receive tracking attachments in
Fulfillment's physical state/read models; the second is NOT a second money-bearing
label-attached fact. Fulfillment must prevent the individual follow-on buy path from
buying the shared parcel again. Group payloads above gain no monetary fields.

Current Settlement in
`bounded-contexts/settlement/features/wallets/integrations/fulfillment-source/fulfillment-source-projection.ts`
derives the seller and Order from the Shipment source, debits the FULL positive
USD label amount, and keys debit/refund IDs by Shipment plus provider label ID.
Therefore emitting full-cost label-attached on both Shipments would double debit;
deduplicating only by provider ID downstream is not the current contract.

| Path | Subject / attribution | Debit and refund behavior |
| --- | --- | --- |
| Shared combined label | Anchor Shipment; anchor Order is ledger attribution, not economic owner of the other Order | One full seller debit; two tracking attachments, no duplicate monetary fact |
| Retry or lost response | Same physical operation, aggregate identity/version and frozen request | Reconcile original operation; never buy to resolve uncertainty |
| Void submitted | Original label and anchor lineage | Lifecycle only; `submitted` is NOT a refund or credit |
| Refund terminal `refunded` | Original provider label and debit, even after re-buy | One credit reversing that debit; `rejected` produces no credit |
| Re-buy after authoritative void | New label generation, same actual-label subject | New debit; late old refund still belongs only to the old debit |
| Seller-elected separate dispatch | Each actual member Shipment owns its own actual label | One debit/refund lineage per label; both Order vectors frozen; extra label cost stays seller-funded |
| Anchor cancelled before packing | No new shared label; surviving member ships under its own Shipment | Never attribute survivor postage to the cancelled anchor; the survivor's own label keeps the existing single full debit; gap funding follows 'Survivor Shipping shortfall'; a `buyer-cancelled` anchor's withheld shortfall reaches the seller through that anchor's reduced refund debit |

### Durable operation identity

The current legacy `buildPurchaseUspsLabelOperationKey` uses
`shipment:<id>:purchase-usps-label:initial` or `after-void:<timestamp>`. The current
mutation-attempt path also has durable provider-operation phases. Group execution
must reuse that boundary, not create a parallel provider client or rely on
`reference` for deduplication.

Ratify a private, versioned group-operation tuple: tenant, ShipmentGroupId,
admission I and committed Shipment version, physical disposition version,
actual-label subject Shipment ID, package ordinal (one in combined V1), operation
kind, and label generation. Generation zero means initial; a replacement generation
is the recorded aggregate version of the authoritative void of the prior label,
not a caller timestamp, random retry ID, row count, or event-type presence.
Encode these as a closed object with `contractVersion: "shipment-group-postage/v1"`,
recursively sort object keys, preserve array order, JSON stringify, and hash the
UTF-8 `chase-sets:shipment-group-postage/v1\n` prefix plus canonical JSON with
SHA-256. The key is `shipment-group-postage:v1:<lowercase-64-hex-digest>`.
Use the recorded committed/disposition/void versions, never the latest stream
version on a retry. The full frozen request hash is checked on every retry. Same
key/different request is a conflict; competing keys for the same actual label
target also conflict, so a disposition change cannot authorize overlapping buys.

Reserve and commit invocation durably before provider I/O. Only that recorded
operation invokes. A crash after invocation is ambiguous until reconciled: no
second buy, no new generation to escape the ambiguity, and no assumption that a
null recovery result proves no purchase. A confirmed purchase resumes local
attachment at the expected aggregate version. Confirmed void permits a new label
generation even while its refund is submitted, but never credits the old debit
early. Duplicate void and day-after purchase retries return their original durable
outcome. Terminal cancellation/void/fraud facts schedule cleanup; no periodic sweep.

### Satisfy both committed policies

Fulfillment must not re-evaluate the active Postage Policy. Keep both member
snapshots and the accepted combined plan. Require the conjunction of their
constraints: parcel/signature/insurance are required if ANY applicable snapshot
requires them; a false requirement is not a prohibition on stronger protection.
Validate actual combined measures, service and package against the accepted plan,
not merely one member's dimensions. Today's `assertPostagePolicyCompliance` checks
parcel path and missing insured value, not dimensional equivalence; it is not proof
that group policy already works.

When insurance is required by either member or the combined committed plan, insure
the whole parcel: sum, in cents, each member's committed item subtotal, using its
committed insured value instead when higher. Also honor any higher insured minimum
in the accepted combined plan. Required-but-missing/malformed insured values,
currency mismatch, or a value outside the evidenced provider envelope fail closed.
No duplicate counting of a combined snapshot as a third member. If no applicable
snapshot requires insurance, request null insurance. Never add protection fees or
Shipping to insured merchandise value or change either Order's money.

| Synthetic policy example | Decision and rationale |
| --- | --- |
| Insured values/subtotals 200.00 and 400.00 | Combined insurance 600.00, not max 400.00 or anchor-only 200.00. It covers both members; the exact provider record below is 300+300, not this synthetic pair. |
| Required insured value 300.00 plus uninsured subtotal 300.00 | Insure the whole parcel for 600.00. Do not interpret one member's false requirement as permission to omit its contents. |
| Anchor allows letter; follow-on requires parcel and signature | Combined parcel with signature only if one plan/service satisfies both and evidence supports that envelope. Neither member is weakened; the captured probe does NOT establish signature acceptance. |
| Combined current measures require two packages, incompatible service, missing value, or no service satisfies both | No one-parcel group offer. Before Form Abort/review; after Form use the lifecycle rules below, never silently downgrade a policy. |

### Bounded external evidence

The only provider authority is #6461's
[records](https://github.com/chase-sets/chase-sets/issues/6461#issuecomment-5901267897)
and [findings](https://github.com/chase-sets/chase-sets/issues/6461#issuecomment-5901268145),
run `36643039793`, attempt 1, artifact
`combined-parcel-probe-public-36643039793-1`, source
`ea18908edc5773607ad518673b831bf80a2ee56e`. They were captured in the EasyPost TEST
rate/buy/cleanup lifecycle, not this product runtime.

| Exact captured case | Parcel/service | Insurance | Observed outcome | Captured / expires (UTC) |
| --- | --- | --- | --- | --- |
| `combined-parcel-uninsured` | Two synthetic members; 7x5x2 inches, 8 oz; GroundAdvantage | null | External mode `test`, accepted, HTTP 200, one purchase, 11 rates / 3 USPS, selected 568 USD cents, voided, refund `submitted` | 2026-09-29T23:03:12.509Z / 2026-10-29T23:03:12.509Z |
| `combined-parcel-insured` | Same parcel/service; synthetic 300.00 + 300.00 members | `"600.00"` | External mode `test`, accepted, HTTP 200, one purchase, 11 rates / 3 USPS, selected 568 USD cents, voided, refund `submitted` | 2026-09-29T23:03:22.228Z / 2026-10-29T23:03:22.228Z |

The records have distinct synthetic correlation references; these are not provider
deduplication proof. They prove neither production/broad-envelope/signature
acceptance, completed refund/settled credit, internal attribution, nor retry safety.
Do not attach a real record identity to altered synthetic facts.

Before consumption, compare `PurchaseUspsLabelRequest`/`PostagePackage` and adapter
`purchaseUspsLabel` on main to the capture SHA, including intervening history.
Any change invalidates this evidence immediately; expiry also requires a fresh
authorized probe. The ratification PR records the exact comparison. An invalid or
insufficient envelope means do not form a group; no provider call is authorized by
this ADR.

## Lifecycle and terminal behavior

### Cancellation producers crossed with every phase

Each cell below applies independently to cancelling EITHER member. `C(reason)`
means the actual target's `ordering.order.cancelled` followed by anchor-owned
member-removed and dissolved with the same exact reason and original pair. The
survivor retains every frozen amount; only the cancelled member refunds/releases.
No producer cancels the survivor to simplify cleanup.

`P(reason)` means pre-Form: anchor cancellation appends admission-aborted
(`cancelled`) then OrderCancelled atomically; a staged-only proposed member is
Abandoned, not sent an illegal CancelOrder. Ordinary already-public cancellation
still applies only to its actual target. Compensation Abort uses `compensating`.
Release reservations/claims from durable causal facts, never a periodic scan.

`F(reason)` means formed-before-activation: do not Abort. Serialize cancellation
on its owning stream; where the target is staged, Activate idempotently then
Cancel with the legitimate reason; keep parent Payment blocked and dissolve.
Anchor cancellation appends OrderCancelled, member-removed, dissolved in that
order. Follow-on cancellation durably drives the anchor's removal/dissolution.
Any unaffected staged survivor is activated once, with its frozen snapshot.

`S(reason)` means packing won: no self-service physical cancellation/release or
silent unpacking. Preserve the incoming cancellation/conflict and route the
existing Support path. If an authorized producer has actually cancelled an Order,
Ordering still records C(reason); dissolved releases only its matched admission,
while Fulfillment retains the packed group's physical history and cancellation
conflict for Support. That release cannot make a packing-started Shipment eligible
for a new group and does not falsely imply a void, refund, or stopped package.
`D` means replay original terminal receipts,
including permanent source Order IDs; no old identity touches a later group.

| Producer / exact reason | Owner and initiating fact | Pre-Form | Formed-before-activation | Committed/pre-packing | Packing-started | Dissolved/day-after |
| --- | --- | --- | --- | --- | --- | --- |
| Buyer / `buyer-cancelled` | Ordering buyer cancellation -> OrderCancelled | P(buyer-cancelled) | F(buyer-cancelled) | C(buyer-cancelled) | S(buyer-cancelled) | D |
| Seller / `seller-cancelled` | Ordering seller cancellation -> OrderCancelled | P(seller-cancelled) | F(seller-cancelled) | C(seller-cancelled) | S(seller-cancelled) | D |
| Support / `support-cancel-order` | Support decision, Ordering cancellation -> OrderCancelled | P(support-cancel-order) | F(support-cancel-order) | C(support-cancel-order) | S(support-cancel-order) | D |
| Support seller-cannot-fulfill / `seller-cannot-fulfill` | Support `cancel-order` resolution on a `seller-cannot-fulfill` flow, Ordering cancellation -> OrderCancelled | P(seller-cannot-fulfill) | F(seller-cannot-fulfill) | C(seller-cannot-fulfill) | S(seller-cannot-fulfill) | D |
| Payment deadline / `payment-deadline` | Ordering deadline reaction -> OrderCancelled | P(payment-deadline) | F(payment-deadline) | C(payment-deadline) | S(payment-deadline) | D |
| Inventory / `inventory-unavailable` | Inventory rejection, Ordering cancellation -> OrderCancelled | P(inventory-unavailable) | F(inventory-unavailable) | C(inventory-unavailable) | S(inventory-unavailable) | D |
| Fraud cancellation / `fraud` | Fraud decision, Ordering cancellation -> OrderCancelled | P(fraud) | F(fraud) | C(fraud) | S(fraud) | D |
| Compensation / `compensating` | Ordering parent failure -> Activate if necessary, OrderCancelled | P(compensating) | F(compensating) | C(compensating) | S(compensating) | D |

Producer eligibility is not expanded by this matrix. A deadline after payment or
an inventory rejection unrelated to the target version is not newly authorized to
cancel. Seeds and lifecycle helpers must use the same decider and causal checks.

### Non-cancellation triggers crossed with every phase

All rows freeze BOTH Orders' money. Local physical transitions are owned by
Fulfillment and recorded against aggregate identity/version; they do not invent
new public group facts or removal reasons. Retrying a trigger replays its exact
recorded effect, not whatever state a current projection suggests.

| Trigger / owner and fact | Pre-Form | Formed-before-activation | Committed/pre-packing | Packing-started | Dissolved/day-after |
| --- | --- | --- | --- | --- | --- |
| Destination correction / Ordering; planned `ordering.order.shipping-destination-corrected.v1` (#6458, single-Order) | Only the paid anchor is correctable; if Form or Commit revalidation sees its changed destination, Abort `quote-stale` and return a replacement preview | Abort is illegal; Activate and take Payment with frozen money; the committed group then follows the destination-mismatch hold | Correct only the target Order; if member destinations now differ, Fulfillment holds combined execution (`destination-mismatch`); no dissolution, R reason or money change | #6458 refuses with `fulfillment-started`; a late fact is #6459's packing conflict for Support; never overwrite a purchased label's address | Apply only to the eligible individual Shipment with a monotonic sequence; duplicate or older sequences are inert; the old group cannot revive |
| Label void / Fulfillment postage path; label-voided then terminal label-refund-status-recorded | No group label exists; stale individual operation cannot establish admission | No group buy before activation/packing; reconcile any prior operation, do not create a label | No group label should exist; refuse ineligible new void, replay an old valid receipt only | Void actual shared label once; physical group awaits replacement; admission stays committed; no Order cancellation; refund only on terminal authority | Original label lineage stays addressable; old refund cannot credit a replacement or new group |
| Fraud warning / Payments warning fact -> Fulfillment conflict | Block physical eligibility and let actual Ordering fraud cancellation use P if authorized; warning alone is not R | Preserve warning/conflict and stop physical progress; actual cancellation follows F | Keep warning distinct from cancellation; no invented removal; authorized cancellation follows C | Existing fraud conflict remains Support-owned; no automatic dispatch/void/cancel-both | Replay source stream/version; cancelled lineage stays terminal; late warning cannot mutate a new admission |
| Incompatible package/policy plan / Ordering preview or Fulfillment physical validation | No offer, or Abort `quote-stale` before Form; replace preview | If formation failed, activate then compensating-cancel actual failed member, dissolve; no Payment | Stop combined packing; separately execute only if each committed policy is satisfiable and seller elects; otherwise Support, not fake cancellation | Stop invalid label purchase/dispatch; Support or permitted void/repack; no policy weakening | No revival; a survivor must satisfy its own committed policy without repricing; an anchor-cancel survivor follows 'Survivor Shipping shortfall' |
| Seller-elected separate dispatch / Fulfillment authorized physical decision | No group to split; individual behavior or wait for formation | Record/defer physical election until commitment and activation; no cancellation | Keep Order Group formed and admission committed; physical Shipment Group records irreversible separate disposition before packing; execute two individual member packages/labels | No silent second label for a shared parcel: reconcile/void shared label before separate repacking; ambiguous provider state blocks; Support when dispatch already occurred | Election replay returns original outcome; dissolved group cannot be re-created by election; surviving individual remains individual |

Separate dispatch is NOT dissolution or member removal: both Orders remain linked,
the original exact-two history stays stable, and committed admission prevents a
third join. Physical combined/separate disposition is explicit, not inferred from
label row count. Its recorded version scopes actual-label operation identities.
For two separately dispatched labels, each member's own Shipment is the singular
postage subject. A change of disposition cannot reissue an uncertain operation.

### Correction is single-Order authority

[#6458](https://github.com/chase-sets/chase-sets/issues/6458) plans paid
`ready-for-fulfillment`, pre-packing correction, separate from broader cancellation
availability. Its public fact contains `orderId`, corrected snapshot, `correctedAt`,
`correctionSequence`, `requestId`, `requestFingerprint`. Actual corrections advance
sequence 0 through 3; same/older deliveries are inert; request replay precedes
current lifecycle gating. This fact is not shipped at the baseline of this ADR.

It authorizes ONE Order, not group-wide consent. Grouping changes none of #6458's availability, precedence, idempotency, sequence or ceiling rules. A correction on a grouped member corrects only that Order. It never dissolves the Order Group, removes a member, uses an R reason, or changes money.

Combined packing, label purchase and dispatch require both members' current destinations to be equal over the normalized physical-recipient fields of `normalizeAddressSnapshot`: name, company, line1, line2, city, state, postalCode, country and phone. Email and verification are excluded. Fulfillment evaluates this on the anchor Shipment's physical authority, using each member Shipment's latest applied correction (#6459 consumption), never a projection. While the destinations differ, the Shipment Group is in the Fulfillment-local physical state `destination-mismatch`. That state is not a public group fact. No combined label is bought, and the linkage and committed admission stay intact.

The hold ends only through existing authorities, with no timer or sweep:
- The buyer independently corrects the other Order to an equal destination under its own #6458 request, and combined execution resumes.
- The seller records the irreversible separate disposition, which is seller-funded under #6460.
- An authorized producer cancels a member (C(reason)).

The grouped purchase detail discloses the mismatch and links each Order's own correction form. It never pre-submits or copies a correction to the peer. A correction that loses the packing race, or arrives after a combined label exists, is the #6458/#6459 late conflict for Support. The label address is never silently overwritten.

## Post-review decisions

### Survivor Shipping shortfall

Todd ruled at https://github.com/chase-sets/chase-sets/issues/6462#issuecomment-5972382100: "Buyer pays even if they didn't get a full refund." This withdraws #7196 A's platform-absorption clause.
- **Scope:** the anchor is cancelled with reason `buyer-cancelled`, in the formed-before-activation or committed/pre-packing phase, while the follow-on is a current, uncancelled member. Every other reason keeps today's full refund, and the gap stays with the seller through the survivor's existing full-label debit. Follow-on cancellation creates no shortfall.
- **Amount:** `S = standaloneSellerShippingPayoutAmount - follow-on sellerShippingPayoutAmount`, in integer cents, clamped at zero. Both values are frozen at formation: #7200 stores the standalone value in the follow-on's frozen snapshot and quote fingerprint. Because the protection terms are identical, S equals the displayed saving.
- **Withholding:** the anchor's own `ordering.order.cancelled` carries S, both frozen payouts, `survivorOrderId` and `orderGroupId`. Payments withholds `W = min(S, remaining refundable, remaining unrefunded anchor seller payout)` from that refund under the kind `order-group-survivor-shipping-shortfall`, and records S, W and `S - W` on its refund facts. The seller bears `S - W` through the existing label debit. The buyer is never charged later, and the platform never funds it.
- **Seller kept whole:** the anchor's single existing `refund` debit becomes `proportional(exposure, refunded + W, cap) - W`, and the protection reversal uses `refunded + W`. The seller keeps exactly W of the anchor's buyer money. There is no new entry, entry kind, platform credit or reserve draw.
- **Release:** if the survivor is later cancelled, Payments refunds the outstanding W on the anchor exactly once, keyed by the anchor Order. The same rule then debits the seller exactly W.
- **Disclosure:** checkout shows S before the follow-on Payment, and the anchor's cancel confirmation shows W.

No group fact gains money, and the survivor is never repriced. Formation stays disabled until the withholding slice lands.

### Evidence-window release cannot reach a group member

`sourceReleaseActions.cancelOrder` in `bounded-contexts/ordering/features/orders/api/runtime.ts` cancels with `reason: "evidence-window-release"`. It exists only for release-verification checkouts: `infrastructure/platform-runtime/evidence-window-source-recovery.ts` admits a governed source only when the effective and observed modes are `test`. Release cancels only Orders that read `live`. A captured Order reads `captured-remedy-required`, which becomes `unknown`, so an eligible paid, awaiting-package anchor is never cancelled by this producer.

Decision: a checkout carrying an evidence-window source is formation-ineligible, like the guest, claimed-account handoff, UCP and accepted-offer entrypoints (#7200 owns the check). Grouped Orders are therefore unreachable by this producer. `evidence-window-release` is neither added to R nor mapped to another reason.

As a guard, Ordering refuses any CancelOrder on a current group member (formed or committed, not dissolved; membership read from the aggregate stream) whose reason is outside R. An unlisted producer therefore fails closed instead of cancelling without removal or being cast into R.

## Alternatives and consequences

| Alternative | Decision / tradeoff |
| --- | --- |
| Platform absorbs the survivor shortfall | Withdrawn by Todd (https://github.com/chase-sets/chase-sets/issues/6462#issuecomment-5972382100); needs a platform-funded posting #6460 forbids. The buyer funds it from the anchor refund. |
| Withhold on every cancellation reason | Reject: seller, Support, inventory and fraud cancellations promise a full refund; the gap stays with the seller. |
| One group owns commercial money | Reject: violates per-Order refunds, allowance/protection and immutable first money. Exact-two linkage is simpler than financial consolidation. |
| N members or member-added events | Reject: exceeds #7196 and changes protocol/cardinality. Dissolution ends the original pair; a new eligible group has new identity. |
| Projection eligibility, expiring lease, or direct-port-only coordination | Reject: packing races, stale generation resurrection and stranded reservations. Aggregate admission plus causal worker recovery costs more protocol but is authoritative. |
| New postage subjectKind for group | Reject for V1: existing singular Shipment subject preserves adapter and Settlement lineage; group identity still scopes the operation. |
| Emit the same monetary label fact on both Shipments | Reject: current Settlement keys by Shipment AND provider label; two debits. Track both, publish money once. |
| Anchor-only or max-member insurance | Reject: undercovers aggregate merchandise value. Sum both members while respecting every committed minimum; fail closed without envelope evidence. |
| Provider reference guarantees retry safety | Reject: captured records explicitly prove one attempt only; local durable invocation/ambiguity authority is necessary. |
| Cancel both or charge survivor after cancellation | Reject: #7196 A preserves survivor; the survivor gap follows 'Survivor Shipping shortfall', never survivor repricing. |
| Separate dispatch dissolves the Order Group | Reject: no genuine member cancellation and no R reason; retain linkage/admission, record physical disposition, seller funds extra labels. |
| Dissolve on destination correction, or propagate it to both | Reject. No member is removed, and R has no correction reason. Dissolution splits a parcel the buyer can make consistent and would trigger the survivor-shortfall rule. Propagation exceeds #6458's single-Order authority. Hold combined execution until the destinations match instead. |

Only the ADR/index, two ID declarations/tests and planned glossary entries ship in
this slice. Runtime aggregates, codecs/registry, migrations, UI, provider adapters,
money postings and physical group execution remain with their named sibling owners.
Cross-buyer/cross-origin/post-packing joins and multi-location split shipments are
not part of V1. The next implementation must not treat proposed language or a
green documentation/ID check as permission to bypass the survivor-shortfall rule or the destination-mismatch hold.
