# Buyer-to-Platform Reverse Logistics and Custody Journey Acceptance

Release-readiness evidence that the buyer-to-platform reverse logistics and custody
journey behaves as **one coherent system** across Fulfillment (the ReturnShipment
aggregate, platform-facility directory, deadline/exception derivation, and
unidentified-package reconciliation), Support / Platform-Operations (the authorized
refund trigger and remedy-effect closure), and Inventory (recovered custody), under
real event ordering and failure conditions.

This is the Wave 3 go-live evidence leaf (epic #5211) for the cross-context behaviour.
It **composes** rather than duplicates the slice coverage already proven by:

- `bounded-contexts/fulfillment/features/return-shipments/domain/domain.test.ts`
  (ReturnShipment aggregate),
- `bounded-contexts/fulfillment/features/return-shipments/domain/facility-directory.test.ts`
  (facility selection and immutable snapshot),
- `bounded-contexts/fulfillment/features/return-shipments/read-model/deadlines.test.ts`
  (derived deadline/exception signals),
- `bounded-contexts/fulfillment/features/return-shipments/domain/unidentified-package.test.ts`
  (unidentified-package reconciliation),
- `bounded-contexts/platform-operations/features/support-requests/domain/remedy.test.ts`
  (exact-once, coverage-gated refund release and closure blocking), and
- `bounded-contexts/platform-operations/features/support-requests/integrations/source/source-projection.test.ts`
  (the milestone-to-refund-trigger correlation).

Passing isolated unit tests is not sufficient. The acceptance matrix below binds every
required journey to authoritative coverage, and the traceability table binds every
custody and money-safety invariant to an automated test or an explicit staging check.
The pin test
`bounded-contexts/fulfillment/tests/reverse-logistics-custody-journey.proof.test.ts`
keeps this matrix from drifting from the required journeys and re-drives the
Fulfillment-owned deciders across the full custody chain (buyer ships back → carrier
tracking milestones → facility intake → disposition), asserting the cross-context money
and custody seam from each context's `context.json`.

## Canonical ownership map

| Fact | Authority | Consumed at seam |
| --- | --- | --- |
| ReturnShipment identity, destination snapshot, carrier custody milestones, exceptions, facility intake | Fulfillment (`fulfillment.return-shipment.*`) | Support (refund triggers), Inventory (recovered custody) |
| Whether a resolution requires return-to-platform and which refund trigger applies | Support / Platform-Operations (`support.support-request.*`) | Payments release, Settlement reconciliation |
| Exact-once, coverage-gated refund release and remedy-effect closure | Support remedy execution | Payments, seller money surfaces |
| Return shipping-cost liability and reserve/ledger recovery | Settlement | Cost desk, payout ledger |
| Recovered stock after facility intake, and recovered value | Inventory (`inventory.recovered-item.*`) | Settlement recovered value |

Fulfillment reports logistics facts; it never moves money. A refund is released only by
Support, and only when the milestone Support **authorized** as the refund trigger is the
milestone Fulfillment actually reported. Carrier webhooks are never coupled to Payments,
Settlement, or Inventory databases.

## Acceptance matrix

Scenario type is one of: **happy path**, **money-safety**, **custody**,
**replay recovery**, **deadline**, **fail-safe**, **privacy**, **rollout**.

| ID | Journey | Scenario type | Goal | Verification evidence |
| --- | --- | --- | --- | --- |
| J01 | Return directive creates one ReturnShipment and platform-destination label | happy path | Exactly one ReturnShipment per authorized directive, one active purchased label, immutable destination snapshot, correct cost payer/allocation | `reverse-logistics-custody-journey.proof.test.ts`, `domain.test.ts`, `facility-directory.test.ts` |
| J02 | Buyer downloads label, carrier accepts, tracks, delivers, facility intakes | custody | Custody advances monotonically to a single facility intake; label document is customer-safe | `reverse-logistics-custody-journey.proof.test.ts`, `domain.test.ts` |
| J03 | Refund trigger on carrier acceptance | money-safety | Carrier-accepted is a distinct, money-free fact that maps only to the carrier-accepted trigger | `reverse-logistics-custody-journey.proof.test.ts`, `remedy.test.ts`, `source-projection.test.ts` |
| J04 | Refund trigger on facility intake | money-safety | Facility-intake is a distinct, money-free fact that maps only to the facility-intake trigger | `reverse-logistics-custody-journey.proof.test.ts`, `remedy.test.ts`, `source-projection.test.ts` |
| J05 | Duplicate directive and label-purchase retry after timeout | replay recovery | Directive replay is a no-op; each retried purchase records a fresh actionable failure; a later success yields one label | `reverse-logistics-custody-journey.proof.test.ts`, `domain.test.ts` |
| J06 | Webhook before API response; duplicate and out-of-order carrier scans | replay recovery | Duplicate and out-of-order scans converge without regressing custody; exact-once milestone publication | `reverse-logistics-custody-journey.proof.test.ts`, `domain.test.ts` |
| J07 | Missing webhook repaired by scheduled reconciliation | deadline | Derived signals are deterministic per `asOf`, naming owner, next action, and escalation | `reverse-logistics-custody-journey.proof.test.ts`, `deadlines.test.ts` |
| J08 | Buyer misses ship-by deadline and label expires/voids | deadline | Ship-by-overdue and void-eligible signals derive after their windows; label voids at most once | `reverse-logistics-custody-journey.proof.test.ts`, `deadlines.test.ts` |
| J09 | Carrier loses/damages/stalls the return | fail-safe | Exception is an overlay that never advances or completes custody, so no unconditional refund | `reverse-logistics-custody-journey.proof.test.ts`, `domain.test.ts` |
| J10 | Carrier reports delivered but facility cannot find the package | fail-safe | Stays delivered with no facility-intake fact; delivery-without-intake signal surfaces to facility ops | `reverse-logistics-custody-journey.proof.test.ts`, `deadlines.test.ts` |
| J11 | Facility receives damaged, empty, extra, substituted, or unidentified package | custody | Discrepant intake never auto-completes; unidentified package reconciles exactly once | `reverse-logistics-custody-journey.proof.test.ts`, `unidentified-package.test.ts` |
| J12 | No eligible facility / provider outage / secure-label storage failure | fail-safe | Unroutable directive fails explicitly (`no-eligible-facility`) and never creates a shipment; outages named in the actionable taxonomy | `reverse-logistics-custody-journey.proof.test.ts`, `facility-directory.test.ts` |
| J13 | Rollout paused while returns are already in flight | rollout | Retiring a facility blocks new directives while an in-flight return still intakes against its immutable snapshot | `reverse-logistics-custody-journey.proof.test.ts`, `facility-directory.test.ts` |
| J14 | Customer and operator views enforce privacy/authorization boundaries | privacy | Customer-safe views drop restricted routing and operator-internal signals; no facility/evidence secrets leak | `reverse-logistics-custody-journey.proof.test.ts`, `facility-directory.test.ts` |

## Cross-context seam contract

The proof asserts the following from each context's `context.json`, so money and
recovered custody can only flow from authorized Fulfillment facts:

- Fulfillment owns the `return-shipment` noun and publishes the custody facts.
- Platform-Operations `support-shipment-source-projection` consumes **only**
  `fulfillment.return-shipment.carrier-accepted.v1`,
  `fulfillment.return-shipment.delivered.v1`, and
  `fulfillment.return-shipment.facility-intake-completed.v1` — never the label-void or
  exception facts, so neither a void nor a carrier exception can drive a refund release.
- Inventory `inventory-fulfillment-recovered-item-workflow` consumes **only**
  `fulfillment.return-shipment.facility-intake-completed.v1`, so recovered stock exists
  only after facility intake establishes platform-controlled custody.
- Settlement consumes recovered value only from
  `inventory.recovered-item.value-reported.v1`, never a raw carrier fact.

The exact-once, coverage-gated refund release itself is owned and unit-proven by
`remedy.test.ts` (`canReleaseRemedyRefund`, `applyRemedyEffectFact`,
`canCompleteRemedy`): a refund releases at most once, only when coverage is reserved and
the authorized trigger effect is satisfied, and Support closure stays blocked until every
required effect (including facility intake for a return-to-platform directive) completes.
The milestone-to-trigger correlation (a delivered scan never satisfies a facility-intake
trigger) is proven by `source-projection.test.ts`.

## Assertions proven

For the journeys above, the proof asserts:

- one ReturnShipment per authorized directive (idempotent by directive/remedy linkage);
- at most one active purchased label (a second label-ready command is a no-op);
- immutable destination snapshot (re-validates to itself; directory edits never rewrite it);
- correct shipping-cost payer/allocation reference stamped on the requested fact;
- non-regressing custody state under duplicate and out-of-order carrier scans;
- exact-once milestone publication (duplicate scans emit nothing);
- refund release only for the configured trigger (distinct, money-free milestone facts);
- one facility intake result per shipment, with discrepant intakes routed to
  quarantine/manual-review, never completed;
- deterministic deadline/exception derivation as the basis for de-duplicated
  customer/operator notifications;
- Support remedy closure blocked until its required effects complete (see `remedy.test.ts`);
- no restricted facility routing, operational contact, or evidence storage key on
  customer-safe views or public facts.

## Observability

Dashboards and alerts for the operational inconsistencies below are derived from the
Fulfillment read models and the derived deadline signals. In this worktree they are
specified and bound to their derivation source; wiring to the metrics backend is recorded
as **pending** on the issue at release time.

| Signal | Source | Alert condition |
| --- | --- | --- |
| Label purchase failures | `label-purchase-failed.v1` failure-reason taxonomy | Any `provider-timeout`, `no-eligible-facility`, or `secure-document-storage-failure` spike |
| Duplicate purchase attempts | repeated `label-purchase-failed.v1` per shipment | More than one failure fact within the retry window |
| Ready-but-unshipped age | `ship-by-reminder` / `ship-by-overdue` signals | Signal age past the escalation window |
| Stalled tracking | `stalled-in-transit` signal | No movement scan beyond `stalledInTransitHours` |
| Provider reconciliation lag | scheduled reconciliation sweep | Missing webhook not repaired within the sweep interval |
| Delivered-not-intaken age | `delivery-without-intake` signal | Delivered without intake past `deliveryWithoutIntakeHours` |
| Unidentified/discrepant packages | `unidentified-return-package.recorded.v1`, discrepant intake dispositions | Any unreconciled package or quarantine/manual-review disposition |
| Trigger-to-refund latency | Support remedy effect timestamps | Authorized trigger satisfied but refund not released within SLA |
| Label cost/void recovery | `label-voided.v1` refund status | Void requested but provider refund unconfirmed |
| Webhook verification failures | carrier webhook ingestion | Signature/verification failure |
| Facility capacity/configuration failures | facility directory selection | `no-eligible-facility` rate by region/carrier |

## Rollout and operations

- **Gating.** Platform-return directives are gated by facility readiness, carrier, and
  region through `selectReturnFacility` (a retired or out-of-region facility yields
  `no-eligible-facility`, proven in J12/J13). Feature-configuration and operator-cohort
  gating on the request surface is recorded as **pending** against its runtime gate.
- **Pause behaviour.** Pausing new directives (retiring facilities from selection) stops
  new returns while active returns continue tracking and intake against their immutable
  captured snapshots (proven in J13).
- **Sandbox label lifecycle.** The proof fixtures use a sandbox postage provider mode and
  a synthetic label document URL; no production address appears in test artifacts.
- **Runbooks.** Provider outage, facility outage, wrong address, lost package,
  delivered-not-found, intake discrepancy, and privacy-incident runbooks are captured in
  the Runbook section below with named owners.

## Runbook: diagnosing reverse-logistics and custody mismatches

Walk the authorities in dependency order. Each context owns exactly one fact; a mismatch
is a stale or missing projection, never a place to re-derive the fact.

1. **Fulfillment is the custody authority.** Read the ReturnShipment milestones for the
   `returnShipmentId`. The furthest delivery stage is monotonic; a lost/damaged/stalled
   return is an exception overlay, not a stage regression. Owner: fulfillment-carrier-ops.
2. **Facility intake.** A discrepant intake routes to quarantine or manual review and
   never claims `completed`. A package received after cancellation/expiry raises an
   exception and routes to quarantine. Owner: facility-operations.
3. **Delivered-not-found.** A carrier `delivered` scan is not custody; the
   `delivery-without-intake` signal owns the reconciliation until a facility intake fact
   exists. Owner: facility-operations.
4. **Support refund trigger.** A refund releases only when the authorized `refundTrigger`
   equals the reported milestone. If a refund is missing, confirm the remedy's authorized
   trigger and that the matching milestone fact exists; if a refund looks duplicated,
   confirm the effect idempotency key — the release is exact-once. Owner: support-return-desk.
5. **Inventory recovered custody.** Recovered stock exists only after
   `facility-intake-completed.v1`. Owner: inventory-recovered-items.
6. **Settlement cost and recovered value.** Return shipping cost payer is explicit on the
   requested fact; recovered value flows only from the Inventory value fact. Owner:
   settlement-cost-desk.

If two views disagree after event lag settles, the later lifecycle fact wins; force a
projection replay for the affected shipment rather than editing a read model by hand.

## Staging evidence

Provider-sandbox label lifecycle and representative staging evidence run against a
deployed environment and are recorded on the issue with deployment and version
identifiers, sandbox accounts, orders, and timestamps. This worktree cannot reach staging
or a provider sandbox, so those rows are recorded here as **pending** and captured on the
issue at release time using this template:

- Deployment or version identifier: _pending_
- Sandbox postage account and label lifecycle capture (purchase → void → refund): _pending_
- Test orders and return directives (per journey id): _pending_
- Facility/operator acceptance signoff with named owners: _pending_
- Captured timestamps and result per required journey: _pending_

## Deferred defects

None recorded at authoring time. Any deferred defect is recorded here and on the issue
with owner, severity, and milestone. P0 money-safety, privacy, or custody-convergence
defects block closure.

| Defect | Owner | Severity | Milestone | Status |
| --- | --- | --- | --- | --- |
| _none_ | | | | |

## Related evidence to compose (not duplicate)

- #3733 — dispute journey tests (Support case lifecycle).
- #571 — fulfillment/postage terminal proof.
- #596, #572 — postage label and shipment proofs.
- #5210 — reserve-backed platform-covered support resolutions; the platform-funded golden
  path composes this shipment-to-platform and facility-custody evidence.

## Ubiquitous language

- **Return shipment** — a buyer-to-platform reverse movement with its own identity,
  destination snapshot, label, tracking, custody milestones, exceptions, and cost payer,
  distinct from the outbound shipment.
- **Destination snapshot** — the immutable, label-safe capture of the selected platform
  facility stamped onto the requested fact; carries no restricted operational routing.
- **Custody milestone** — a monotonic delivery stage (requested → ready-to-ship →
  carrier-accepted → in-transit → delivered → received); duplicate or out-of-order scans
  never regress it.
- **Refund trigger** — the Support-authorized milestone (`carrier-accepted`, `delivered`,
  `facility-intake`, `operator-release`, or `immediate`) that releases the refund, at
  most once, when its effect is satisfied.
- **Facility intake** — the facility's custody acknowledgement with evidence, discrepancy
  state, and disposition; a discrepant intake never auto-completes.
- **Recovered item** — platform-controlled stock that exists only after facility intake
  hands custody to Inventory.
