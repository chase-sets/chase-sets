# Reputation and Support Fair Journey Acceptance

Release-readiness evidence that the fair order-issue and review journeys behave as
**one coherent system** across Support (platform-operations), Marketplace reviews and
seller metrics, Settlement holds, and Notifications, under real event ordering and
failure conditions.

This is the Wave 3 release-readiness leaf for the cross-context behavior. It
**supplements** the core dispute journeys proven by the Support test surfaces
(`bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts`)
and must not replace their support-specific coverage.

Passing isolated unit tests is not sufficient. The acceptance matrix below binds
every required journey to authoritative-state coverage and the traceability table
binds every fairness, money-safety, and privacy invariant to an automated test or an
explicit staging check. The pin test
`bounded-contexts/marketplace/tests/reputation-support-fair-journey.proof.test.ts`
keeps this matrix from drifting from the required journeys and re-drives the
reputation-fairness deciders in a journey framing.

## System-of-record map

| Fact | Authority | Consumed at seam |
| --- | --- | --- |
| Factual responsibility and case lifecycle | Support (`support.support-request.*`) | Marketplace reviews, Marketplace seller metrics, Settlement holds, Notifications |
| Seller-proceeds hold and refund/clawback visibility | Settlement (`settlement.support-hold.*`) | Notifications, seller money surfaces |
| Review eligibility, submission, visibility, scoring, aggregate rating | Marketplace reviews | Public and authenticated review reads |
| Seller-responsible issue rate | Marketplace seller metrics | Seller dashboard, buyer-facing chip gate |
| Scheduled and sent case notifications | Notifications | Buyer and seller inboxes |

Money state changes only through Support and Settlement workflows. Review actions
never move money. Support contributes factual responsibility only; remedy, evidence,
and coverage never determine rating (ADR 0022 correlation only).

## Acceptance matrix

Scenario type is one of: **happy path**, **fairness**, **hold timing**,
**replay recovery**, **fail-safe**, **privacy**, **moderation boundary**, **audit**.
Every row exercises both buyer and seller directions, including one account acting in
both roles.

| ID | Journey | Scenario type | Goal | Verification evidence |
| --- | --- | --- | --- | --- |
| J01 | Normal transaction, no case | happy path | Both directions submit in the 60-day window, double-blind reveal works, both reviews score | `reputation-support-fair-journey.proof.test.ts`, `directional-review-disposition.test.ts` |
| J02 | Resolution-first buyer intercept | happy path | 1-2 stars or a problem indicator routes to protected order-issue intake, feedback-only never waives support rights or moves money | `reputation-support-fair-journey.proof.test.ts`, `review-resolution.test.ts` |
| J03 | Seller responsibility, full refund | fairness | Buyer-to-seller Included, seller-to-buyer Context-only, seller-responsible issue-rate numerator increments | `reputation-support-fair-journey.proof.test.ts`, `behavioral-metrics-sql.db.test.ts` |
| J04 | Seller responsibility, replacement or no monetary remedy | fairness | Remedy never changes the responsibility-driven scoring; still seller-responsible | `reputation-support-fair-journey.proof.test.ts`, `directional-review-disposition.test.ts` |
| J05 | Buyer responsibility, refund or return | fairness | Seller-to-buyer Included, buyer-to-seller Context-only, no seller issue-rate impact | `reputation-support-fair-journey.proof.test.ts` |
| J06 | Carrier responsibility, refund | fairness | Both directions Context-only, neither aggregate rating lowered, no seller issue-rate impact | `reputation-support-fair-journey.proof.test.ts` |
| J07 | Platform responsibility | fairness | Both directions Context-only, no aggregate rating impact | `reputation-support-fair-journey.proof.test.ts` |
| J08 | Shared responsibility | fairness | Both directions Context-only, no aggregate rating impact | `reputation-support-fair-journey.proof.test.ts` |
| J09 | Undetermined responsibility | fairness | Both directions Context-only, fails safe to no rating impact and no issue-rate impact | `reputation-support-fair-journey.proof.test.ts` |
| J10 | Partial refund and multi-line order | fairness | Partial and multi-line resolutions score by responsibility, not by refund amount | `reputation-support-fair-journey.proof.test.ts`, `review-eligibility-sql.db.test.ts` |
| J11 | Case opens before any review | hold timing | Both directions held, no submission, reveal, reminder, or rating impact while open | `reputation-support-fair-journey.proof.test.ts`, `review-hold-reaction.test.ts` |
| J12 | Case opens after submit or reveal, and after a review is public and cached | hold timing | Revealed feedback retracts while held and restores on release without content change | `review-eligibility-sql.db.test.ts`, `review-hold-reaction.test.ts` |
| J13 | Case opens after the original review deadline expired | hold timing | An already expired opportunity is never revived by a later case | `reputation-support-fair-journey.proof.test.ts`, `directional-review-disposition.test.ts` |
| J14 | Case cancelled, resolved, reopened, and overlapping cases in either order | hold timing | Public, authenticated, aggregate, ranking or risk, and notification views agree after settle | `review-eligibility-sql.db.test.ts`, `support-hold-lifecycle.test.ts` |
| J15 | Duplicate and reordered support events, resolution observed before open then replay | replay recovery | Convergent recompute; terminal-before-open and duplicate delivery reach the same disposition | `reputation-support-fair-journey.proof.test.ts`, `review-eligibility-sql.db.test.ts` |
| J16 | Projection restart and full replay, notification retry | replay recovery | Idempotent facts and at-most-once notifications survive restart and retry | `review-eligibility-sql.db.test.ts`, `support-dispute-notifications.test.ts` |
| J17 | Support, Settlement, or Marketplace read model temporarily unavailable, stale cache invalidation | fail-safe | System fails safe to no rating impact and no private-data exposure where authority is unavailable | `reputation-support-fair-journey.proof.test.ts` |
| J18 | Unknown or legacy responsibility value | fail-safe | Quarantined held or Context-only, never scored by accident, surfaced as a missing-responsibility signal | `reputation-support-fair-journey.proof.test.ts`, `directional-review-disposition.test.ts` |
| J19 | Moderation and correction boundaries | moderation boundary | Held or Context-only reviews can be reported but moderation never resurrects or rescores them; Support CSAT stays separate; review reporting never implies a money-decision appeal | `reputation-support-fair-journey.proof.test.ts` |
| J20 | Privacy, dual-role, and abuse | privacy | Signed-out and counterparty views hide case, payment, evidence, held content, and reporter identity; duplicate report or reply is rejected by its owning policy | `reputation-support-fair-journey.proof.test.ts` |
| J21 | Seller-proceeds hold and refund clawback visibility | audit | Seller proceeds are visibly held through Settlement-owned data; refund resolutions consume the hold, non-refund resolutions release it | `support-hold-lifecycle.test.ts`, `support-source-projection.test.ts` |

## Cross-context seam contract

The proof asserts the following subscriptions from each context's `context.json`, so
money and rating facts can only flow from Support and Settlement events:

- Marketplace `marketplace-review-support-source-projection` subscribes to
  `support.support-request.opened`, `resolved`, `cancelled`.
- Marketplace `marketplace-review-hold-reaction` reacts to
  `support.support-request.opened`, `resolved`, `cancelled`.
- Marketplace `marketplace-seller-metrics-support-source-projection` subscribes to
  `support.support-request.resolved` only (the issue-rate numerator source).
- Settlement `settlement-support-hold-lifecycle-projection` and
  `settlement-support-hold-projection` subscribe to the case lifecycle so seller
  proceeds are held and released or consumed by Settlement, never by a review.
- Notifications `notifications-support-dispute-facts-projection` subscribes to the
  case lifecycle for scheduled and sent dispute notifications.

## Traceability

Every acceptance-criterion invariant maps to an automated test or an explicit
staging check.

| Invariant (#5206 / #5226) | Automated evidence | Staging or manual check |
| --- | --- | --- |
| No carrier, platform, shared, or undetermined scenario lowers either party's aggregate rating | `reputation-support-fair-journey.proof.test.ts` fairness journeys J06-J09 | Staging: compare seller aggregate before and after a carrier-responsible refund |
| No open case permits submission, reveal, reminder, or rating impact | `reputation-support-fair-journey.proof.test.ts` J11, `review-hold-reaction.test.ts` | Staging: open a case, confirm review form is held and no reminder fires |
| Low or problem feedback routes to protected issue intake without publishing text | `review-resolution.test.ts`, `reputation-support-fair-journey.proof.test.ts` J02 | Browser: submit 1-star, confirm intercept and prefilled issue, draft not submitted |
| Money state changes only through Support and Settlement, never review actions | seam contract in proof test, `support-hold-lifecycle.test.ts`, `support-source-projection.test.ts` | Staging: confirm review actions never alter hold or wallet ledger |
| Seller-responsible issue-rate numerator counts only `seller` responsibility | `reputation-support-fair-journey.proof.test.ts` J03-J09, `behavioral-metrics-sql.db.test.ts` | Staging: dashboard numerator matches resolved seller-responsible orders |
| Aggregates and UI agree after event lag settles, restart, and replay | `review-eligibility-sql.db.test.ts`, proof J15-J16 | Staging: restart projections, confirm read models reconverge |
| Unknown or legacy responsibility fails safe to no rating impact | proof J18, `directional-review-disposition.test.ts` | Staging: inject a legacy value, confirm quarantine and missing-responsibility signal |
| Signed-out and counterparty cannot see case, payment, evidence, held content, or reporter identity | proof J20 | Browser: signed-out and counterparty views of a held review |
| Support CSAT stays separate from transaction review state | proof J19 | Staging: confirm CSAT survey never mutates transaction review aggregate |
| Keyboard, screen-reader, focus, responsive, and non-color status semantics pass | pending browser acceptance | Browser: axe and keyboard pass on review and intercept surfaces |

## Runbook: diagnosing Support, Marketplace, Settlement, and Notifications mismatches

When a review outcome, rating, hold, or notification looks wrong for an order, walk
the authorities in dependency order. Each context owns exactly one fact; a mismatch is
always a stale or missing projection, never a place to re-derive the fact.

1. **Support is the responsibility authority.** Read the resolved
   `support.support-request.resolved` fact for the order: `resolution.responsibility`
   and `resolutionType`. If responsibility is absent or unrecognized, downstream must
   quarantine, not guess. Confirm the case status is `open`, `resolved`, or
   `cancelled`; any other status downstream is a projection lag.
2. **Marketplace reviews.** Recompute expected disposition from responsibility with
   `decideDirectionalReviewDisposition`. Included versus Context-only must match the
   baseline scoring matrix in the Marketplace README. If the read model disagrees,
   re-run `marketplace-review-support-source-projection` for the order; the recompute
   is convergent and re-arms on suspend and restore.
3. **Marketplace seller metrics.** Only `seller` responsibility increments the
   issue-rate numerator. A missing responsibility appears as a
   missing-responsibility signal, never as fault. If the numerator looks high, list
   orders with `responsibility = 'seller'` in the window and compare.
4. **Settlement holds.** Seller proceeds held for an open case appear in
   `settlement_support_holds` with `active = true`. A refund resolution keeps the hold
   until it is consumed; a non-refund resolution releases it. If a seller reports held
   funds after resolution, confirm the resolution type and the coverage-reconciled
   release reason.
5. **Notifications.** Scheduled reminders fire only while a case is waiting on a
   party; a hold does not fire an extra nudge. Notifications are at-most-once per
   intent, so a duplicate is a retry, not a second event.

If two views disagree after event lag has settled, the later-arriving fact wins by
lifecycle time; force a projection replay for the affected order rather than editing a
read model by hand.

## Staging evidence

Browser acceptance and representative staging evidence run against a deployed
environment and are recorded on the issue with deployment and version identifiers,
test accounts, orders, and timestamps. This repository worktree cannot reach staging,
so the browser and staging rows above are recorded here as **pending** and captured on
the issue at release time using this template:

- Deployment or version identifier: _pending_
- Test accounts (buyer, seller, dual-role): _pending_
- Test orders (per journey id): _pending_
- Captured timestamps and result per required journey: _pending_

## Deferred defects

None recorded at authoring time. Any deferred defect is recorded here and on the issue
with owner, severity, and milestone. P0 policy, privacy, or convergence defects block
closure.

| Defect | Owner | Severity | Milestone | Status |
| --- | --- | --- | --- | --- |
| _none_ | | | | |

## Ubiquitous language

- **Factual responsibility** — Support's classification of whose controllable action
  primarily caused an order problem: `seller`, `buyer`, `carrier`, `platform`,
  `shared`, or `undetermined`. Independent of any remedy.
- **Scoring disposition** — whether a review's rating is `included` in reputation
  aggregates or is `context-only` (publishable but excluded from rating).
- **Review hold** — a pause on submission, reveal, reminders, replies, and aggregation
  while a review-affecting case is open, keyed to the stable Support request id.
- **Seller-responsible issue rate** — the seller behavioral metric whose numerator
  counts only `seller`-responsibility resolved orders.
- **Support hold** — Settlement-owned hold on seller proceeds while a case is open;
  released on a non-refund resolution, consumed on a refund or clawback resolution.
