# CSAT End-to-End Journey Acceptance

Terminal launch-readiness evidence (issue #5156) that Customer Feedback behaves as
**one coherent system** from a real customer outcome through invitation,
presentation, submission, projection, low-score attention, triage, consented
follow-up, privacy, and operator reporting — and that forbidden actors cannot
reach it.

This is the Wave 3 go-live evidence leaf for the Customer Feedback epic (#5144).
It **composes** the foundations proven by the sibling slice suites (invitation
issuance #5147, recording/analytics #5148, case lifecycle #5149, coverage
#5150/#5151/#5152, dashboard/queue #5153, attention/follow-up #5154, privacy
#5155, and the RBAC isolation #5145) and re-drives them in a single journey
framing. It does not replace those slice-specific suites.

Passing isolated unit tests is not sufficient. The acceptance matrix below binds
every required journey to authoritative-state coverage, and the traceability
table binds every capture, scoring, attention, follow-up, replay, deploy-skew,
privacy, and negative-RBAC invariant to an automated test or an explicit staging
check. The pin test
`bounded-contexts/customer-feedback/tests/csat-end-to-end-journey.proof.test.ts`
keeps this matrix from drifting from the required journeys and re-drives the
customer-feedback deciders (a `decide` → `evolve` fold, exactly as a real command
handler folds an aggregate) in a journey framing.

## System-of-record map

| Fact | Authority | Consumed at seam |
| --- | --- | --- |
| Eligible workflow outcome (checkout recovered, order delivered, payout completed, ...) | Source context (checkout, fulfillment, marketplace, inventory, settlement, discovery, identity, auth, platform-operations) | Customer Feedback invitation issuance |
| Survey identity, invitation lifecycle, submission, consent capture | Customer Feedback CSAT slice | CSAT analytics, feedback cases |
| CSAT and response rate | Customer Feedback analytics projection | Operator dashboard and export |
| Feedback case lifecycle, disposition, follow-up, attention | Customer Feedback cases + attention slices | Operator queue, Notifications digest/follow-up |
| Follow-up / attention / digest notification delivery | Notifications | Buyer and operator inboxes |
| Privacy hold, redaction, retention, export audit | Customer Feedback privacy slice | Every downstream read and export |

A client may never assert workflow/entity provenance directly: an invitation is
issued only by redeeming a server-authoritative outcome fact whose
`(outcomeCode, sourceContext)` pair is authoritative in the registry. Money and
transaction state never change through a survey action. Notifications flow only
along the subscriptions declared in each context's `context.json`.

## Acceptance matrix

Scenario type is one of: **happy path**, **branch coverage**,
**failure/recovery**, **closed loop**, **deterministic edge**,
**negative RBAC**, **consent**, **replay recovery**, **deploy skew**,
**metric honesty**, **privacy**, **seam**.

| ID | Journey | Scenario type | Goal | Verification evidence |
| --- | --- | --- | --- | --- |
| J01 | Commerce outcome → invitation → present → satisfied submission | happy path | Server-issued invitation, opaque public reference, deliberate rating with versioned this-response-only consent, no default answer | `csat-end-to-end-journey.proof.test.ts`, `invitation-decider.test.ts` |
| J02 | Seller/money branch journey (#5151) | branch coverage | A real journey each for payout, listing, offer, and inventory outcomes | `csat-end-to-end-journey.proof.test.ts`, `workflow-outcomes.test.ts` |
| J03 | Discovery/onboarding branch journey (#5152) | branch coverage | A real journey each for onboarding, discovery, registration, and authentication outcomes | `csat-end-to-end-journey.proof.test.ts`, `workflow-outcomes.test.ts` |
| J04 | Checkout failure then recovery | failure/recovery | One analyzable recovered outcome; redelivered fact and re-submit are no-ops, no duplicate response | `csat-end-to-end-journey.proof.test.ts`, `invitation-decider.test.ts` |
| J05 | Low score → attention → consented follow-up → close | closed loop | Low score raises urgent attention, triage/assign/due, consented follow-up delivers and completes, disposition closes; closure blocked while follow-up pending | `csat-end-to-end-journey.proof.test.ts`, `feedback-case-decider.test.ts`, `attention.test.ts` |
| J06 | Reopen a closed case | closed loop | Reopen returns to triaged, clears disposition, and re-requests attention | `csat-end-to-end-journey.proof.test.ts`, `feedback-case-decider.test.ts` |
| J07 | Dismiss then return and submit | deterministic edge | A dismissed but presented invitation still accepts a deliberate submission | `csat-end-to-end-journey.proof.test.ts`, `invitation-decider.test.ts` |
| J08 | Expiration past TTL | deterministic edge | Presenting past the invitation TTL expires it and never revives it | `csat-end-to-end-journey.proof.test.ts`, `sampling.test.ts` |
| J09 | Duplicate tab / double submit | deterministic edge | Identical submission is idempotent; a divergent submission is a hard conflict, never a silent overwrite | `csat-end-to-end-journey.proof.test.ts`, `invitation-decider.test.ts` |
| J10 | Duplicate / out-of-order outcome facts | deterministic edge | Re-evaluating the same fact after issuance converges to a no-op | `csat-end-to-end-journey.proof.test.ts`, `invitation-decider.test.ts` |
| J11 | Operator attention surface RBAC | negative RBAC | Anonymous, ordinary account, view/notify/manage/export-only staff each get exactly their capabilities; export stays behind the dedicated privacy capability | `csat-end-to-end-journey.proof.test.ts`, `attention-access.test.ts` |
| J12 | Feedback-case command RBAC | negative RBAC | Lifecycle commands require manager authority; notify authority is limited to delivery commands | `csat-end-to-end-journey.proof.test.ts`, `feedback-case-decider.test.ts` |
| J13 | Follow-up notification delivery guard | consent | Delivery is allowed only when case, consent, recipient, channel, and template match; withdrawn consent and recipient mismatch are denied; unrelated messages pass through | `csat-end-to-end-journey.proof.test.ts`, `delivery-authorization.test.ts` |
| J14 | Replay from empty projection | replay recovery | Re-folding the invitation and case event logs reproduces identical aggregate state | `csat-end-to-end-journey.proof.test.ts`, `projection.test.ts` |
| J15 | Rolling-deploy skew | deploy skew | Versionless native events default to v1, explicit versions are read, legacy maps to the non-CSAT classification, unknowns surface as unrecognized | `csat-end-to-end-journey.proof.test.ts`, `replay-compat.test.ts` |
| J16 | CSAT and response-rate honesty | metric honesty | Legacy and incompatible-version ratings are excluded from both numerator and denominator; a zero denominator reads null, never 0% | `csat-end-to-end-journey.proof.test.ts`, `csat-metric.test.ts`, `analytics-query.test.ts` |
| J17 | Redaction protection | privacy | Redaction clears free text and identifiers, withdraws follow-up consent, is replay-stable and idempotent; an active privacy hold blocks it until released | `csat-end-to-end-journey.proof.test.ts`, `policy.test.ts`, `runtime.test.ts` |
| J18 | Redaction cascade into the case | privacy | A response redaction withdraws consent, cancels follow-up, and marks the case redacted | `csat-end-to-end-journey.proof.test.ts`, `feedback-case-decider.test.ts` |
| J19 | Cross-context seam | seam | Case opening, delivery recording, and notification routing flow only along the declared context.json subscriptions; Customer Feedback has no inbound context dependency | `csat-end-to-end-journey.proof.test.ts`, `customer-feedback-notifications.test.ts` |
| J20 | Provenance authority | seam | Each outcome code is authoritative only from its owning source context; a spoofed owner is rejected; every registered code is covered | `csat-end-to-end-journey.proof.test.ts`, `outcome-fact.test.ts` |

## Traceability

Every acceptance-criterion invariant maps to an automated test or an explicit
staging check.

| Invariant (#5156) | Automated evidence | Staging or manual check |
| --- | --- | --- |
| Customer browser journey: outcome → invitation → visible prompt → deliberate rating/comment/consent → confirmation → dashboard metric/queue/detail | proof J01, `admin-http.test.ts` | Browser: submit against a deployed admin + marketplace host and observe the dashboard metric, queue row, and detail |
| At least one real journey per coverage branch | proof J02-J03 | Staging: produce a real payout, listing, and onboarding outcome fact and observe an invitation each |
| Failure/recovery yields a single analyzable outcome, no duplicate response | proof J04 | Staging: fail then recover a checkout and confirm exactly one recovered survey |
| Closed loop: low score → attention → assignment/priority/due → consented follow-up → disposition/close → dashboard/backlog update | proof J05-J06, `attention.test.ts`, `digest-runner.test.ts` | Staging: drive a 1-star case through follow-up delivery and confirm the queue and dashboard update |
| Dismiss/return, expiration, stale page, duplicate tab, offline retry, double submit, optimistic-concurrency conflicts behave deterministically | proof J07-J10 | Browser: exercise dismiss/return, expiry, duplicate tab, and double submit against the deployed prompt |
| Negative RBAC covers anonymous, ordinary account roles, view/notify/manage/export-only staff, cross-account replay, guessed admin URLs, marketplace-host routing | proof J11-J12, `attention-access.test.ts` | Staging: run the permission matrix against deployed admin and marketplace routes and retain status codes without secrets |
| Replay from an empty projection reproduces invitations, metrics, cases, redactions, and audit exactly | proof J14, J17, `projection.test.ts` | Staging: rebuild the Customer Feedback projections and confirm metrics/cases/redactions are identical |
| Old/new event and API versions tolerate rolling-deploy skew; incompatible clients get explicit errors | proof J15 | Staging: replay legacy `experience.platform-feedback.*` events and confirm they never enter CSAT |
| Projection lag/stale/error states render honestly and recover without duplicate commands | proof J16 (null-denominator/exclusion honesty) | Browser: force projection lag and confirm the dashboard renders an honest availability state |
| Pagination stable under concurrent submissions; export complete, formula-safe, authorized, audited, expiring | `analytics-query.test.ts`, `admin-queries.test.ts`, `admin-http.test.ts` | Staging: run a filtered export under concurrent submissions and confirm completeness, CSV formula-safety, audit, and expiry |
| Redacted/retained data stays protected after replay, export, notification retry, cache refresh, detail navigation | proof J17-J18, `policy.test.ts` | Staging: redact a response and confirm protection survives export, retry, and detail navigation |
| Accessibility: keyboard, screen reader, focus, contrast, zoom, mobile/touch, reduced motion using design-system patterns | pending browser acceptance | Browser: axe and keyboard pass on the prompt and operator surfaces |
| Performance meets the budgets recorded by the owning query issues | pending representative-scale run | Staging: representative invitation/response/case volume within budget |
| Observability: alerts/health for projection lag, invitation-rejection anomalies, retention/redaction failure, export failure, overdue backlog | proof J16 (health honesty), pending deployed alerts | Staging: trip each alert and confirm it fires |

## Pending surfaces

Where a step depends on a surface still landing, the proof asserts against the
merged contract and this row is marked pending:

- Source-context outcome-fact publishers exist today for the seller/money branch
  (listing, offer, inventory, payout). The commerce and discovery/onboarding
  publishers are proven here against the shared `createCsatOutcomeFactV1`
  contract and the authoritative provenance registry; wiring each source
  workflow to emit its fact is tracked by #5150 and #5152.
- Browser, deployed admin + marketplace host topology, DB-scale pagination and
  export, accessibility, performance, and observability alerting run against a
  deployed environment and are recorded on the issue at release time.

## Representative-staging evidence

Browser acceptance and representative-staging evidence run against a deployed
environment and are recorded on the issue with deployment and version
identifiers, support-safe actor aliases, orders, and timestamps. This repository
worktree cannot reach staging, so the browser and staging rows above are recorded
here as **pending** and captured on the issue at release time using this
template:

- Environment / commit / deployment identifier: _pending_
- Support-safe actor aliases (buyer, seller, dual-role, view-only, manager, export-only): _pending_
- Test outcomes/orders per branch journey (commerce, seller, discovery): _pending_
- Captured 7/30-day CSAT, response rate, distributions, workflow segmentation, low-score case, closed-loop result: _pending_
- Projection rebuild/catch-up equality result: _pending_
- Permission-matrix status codes/routes (no credentials, cookies, invitation secrets, or PII): _pending_
- Export creation/download/expiry and redaction-propagation result: _pending_

## Deferred defects

None recorded at authoring time. Any product bug discovered here becomes a new
fixed-scope Wave 2 or Wave 3 issue with expected/observed, owning context, exact
URL/workflow, and artifact link; it is recorded here and on the issue with owner,
severity, and milestone. P0 policy, privacy, or convergence defects block closure.

| Defect | Owner | Severity | Milestone | Status |
| --- | --- | --- | --- | --- |
| _none_ | | | | |

## Runbook: diagnosing a CSAT journey mismatch

When a survey, metric, case, follow-up, or redaction looks wrong, walk the
authorities in dependency order. Each slice owns exactly one fact; a mismatch is
a stale or missing projection, never a place to re-derive the fact.

1. **Source outcome fact.** An invitation exists only for a redeemed
   server-authoritative outcome fact whose `(outcomeCode, sourceContext)` pair is
   authoritative. A missing invitation is usually a missing or unauthoritative
   fact, never a client claim.
2. **Invitation aggregate.** Re-fold the invitation events; the lifecycle state
   (eligible → issued → presented → submitted, or dismissed/expired/suppressed/
   revoked) is deterministic. Duplicate or out-of-order facts converge to a
   no-op on the redeemed aggregate.
3. **Analytics.** CSAT counts only CSAT-eligible submissions of the same survey
   version; response rate divides unique submissions by unique presentations. A
   zero denominator reads null, never 0%. Legacy and incompatible versions are
   structurally excluded.
4. **Cases and attention.** A rating of 1-3 with `openReason: low-score` opens a
   case; ratings 1-2 raise attention. Follow-up requires applicable affirmative
   consent for the case consent version; the notification delivery guard re-checks
   consent, recipient, channel, and template at the seam.
5. **Privacy.** Redaction clears free text and identifiers and withdraws consent;
   an active hold blocks redaction until released; redaction is replay-stable and
   idempotent, and cascades to mark the case redacted.

If two views disagree after event lag settles, force a projection replay for the
affected invitation or case rather than editing a read model by hand.

## Ubiquitous language

- **Outcome fact** — a server-authoritative fact a source context publishes for a
  completed workflow outcome; the only basis for issuing an invitation.
- **Invitation** — a server-issued, sampled, expiring redemption opportunity with
  an opaque public reference; never client-asserted provenance.
- **CSAT** — submitted ratings of 4 or 5 divided by all CSAT-eligible submitted
  ratings for the same survey version and filter set.
- **Response rate** — unique submitted invitations divided by unique presented
  invitations.
- **Feedback case** — the attributed, event-sourced lifecycle opened from an
  immutable low-score response: triage, ownership, priority, disposition, linked
  work, consented follow-up, closure, reopen.
- **Attention** — low-score classification and triage-SLA aging that feeds the
  operator surface and the staff digest.
- **Follow-up consent** — affirmative, versioned, `this-response-only`,
  `case-specific-follow-up` consent captured at submission; re-checked at the
  notification delivery seam.
- **Privacy capabilities** — the staff privacy capability set: `view-comments`,
  `export-sensitive-feedback`, `follow-up`, `redact-feedback`,
  `manage-feedback-holds`, and `audit-feedback-privacy`.
