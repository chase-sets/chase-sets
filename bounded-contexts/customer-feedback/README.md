# Customer Feedback Bounded Context

## Purpose

Customer Feedback is the canonical home for customer-satisfaction capture. It owns
survey instruments and versions, invitation/eligibility/sampling/presentation,
survey responses, CSAT and response-rate analytics, feedback cases, and feedback
privacy semantics.
It is the start-gate context for the launch-ready CSAT capability (epic #5144) and
supersedes the acknowledged mixed-responsibility `platform-feedback` slice inside
Platform Operations.

The foundation establishes the context and its **versioned CSAT contract**.
Source contexts publish completed Outcome Facts; Customer Feedback consumes them
and decides whether to issue an invitation. Customer Feedback never reaches into
another context's aggregate or database, and no downstream context imports its
internals.

## Owns

- The versioned survey registry: survey kind and `(surveyVersion, questionVersion)`
  identity, and the v1 transactional-CSAT instrument (1–5, anchored, no default).
- The stable workflow/outcome-code allow-list and its source-context ownership map.
- The source-context Outcome Fact schema (versioned, server-authoritative).
- Sampling-policy / cohort metadata.
- The invitation shape, its authoritative provenance, and its versioned lifecycle
  event contracts.
- The CSAT and response-rate calculation contract, recording flow, replayable
  analytics facts, operating windows, distributions, trends, and data-quality
  states.
- The closed-loop Feedback Case lifecycle, including triage, ownership, priority,
  due dates, dispositions, linked work, consented follow-up, closure, and reopen.
- The migrate-not-reset legacy classification and the replay-compatibility base.

## Does Not Own

- Composing the survey UI. Customer Feedback owns the server-side recording and
  analytics behavior; deployables only compose those surfaces.
- Composing the feedback case operator UI and bulk route adapters.
- The source-context outcomes themselves (checkout, fulfillment, settlement, …):
  those contexts own and publish their Outcome Facts.
- Notification delivery channels (Notifications) and staff capability assignment
  (Identity/Auth).

## Ubiquitous Language

Customer Feedback terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- CSAT Invitation (aggregate): redeems an authoritative Outcome Fact, records
  eligibility and a sampling decision, then governs issuance, presentation,
  dismissal, single-use submission, expiry, suppression, and revocation.
- Feedback Case (aggregate): opens from one immutable submitted response and owns
  attributed operational work without mutating or copying the customer comment.

## Incoming Dependencies

- None wired yet. Source contexts will publish Outcome Facts
  (`CsatOutcomeFactV1`) that this context consumes to decide invitations; the
  first publishers are the journey-coverage leaves (#5150/#5151/#5152). The
  contract is defined here so those leaves emit exactly this shape.

## Outgoing Integration Events

- `customer-feedback.invitation.eligible`
- `customer-feedback.invitation.issued`
- `customer-feedback.invitation.presented`
- `customer-feedback.survey.submitted`
- `customer-feedback.invitation.dismissed`
- `customer-feedback.invitation.expired`
- `customer-feedback.invitation.suppressed`
- `customer-feedback.invitation.revoked`
- `customer-feedback.case.opened`
- `customer-feedback.case.triaged`
- `customer-feedback.case.assigned`
- `customer-feedback.case.unassigned`
- `customer-feedback.case.priority-set`
- `customer-feedback.case.due-date-set`
- `customer-feedback.case.disposition-set`
- `customer-feedback.case.work-item-linked`
- `customer-feedback.case.work-item-unlinked`
- `customer-feedback.case.follow-up-requested`
- `customer-feedback.case.follow-up-sent`
- `customer-feedback.case.follow-up-outcome-recorded`
- `customer-feedback.case.follow-up-consent-withdrawn`
- `customer-feedback.case.closed`
- `customer-feedback.case.reopened`

Every native lifecycle event carries `eventSchemaVersion: 1`. Issuance includes an
opaque public reference and the complete persisted sampling decision plus policy
schema version.

`customer-feedback.sampling.cooldown-claimed` is an internal versioned policy
fact. It is atomically appended with an issued invitation on a deterministic
per-subject/workflow stream, so concurrent outcome delivery cannot bypass the
cooldown.

## Invariants

1. CSAT counts only submitted ratings of 4 or 5 over all submitted ratings for the
   SAME `transactional-csat` survey version. Other instrument kinds and
   incompatible question versions are never mixed into the numerator or
   denominator.
2. A rating input starts unanswered: there is no preselected value, and submission
   is impossible until a value is deliberately chosen.
3. Response rate is unique submitted invitations divided by unique presented
   invitations; a zero denominator yields an unknown (null) figure, never 0%.
4. An invitation's provenance is server-issued: it redeems a source-context Outcome
   Fact and is never created from client-supplied workflow or entity claims.
5. Legacy generic ratings are classified as the non-CSAT `legacy-experience-rating`
   kind and can never enter CSAT; legacy events remain replayable (migrate, not
   reset).
6. Customer Feedback never reaches into another context's aggregate or database,
   and no downstream context imports Customer Feedback internals.
7. `issuanceEnabled` is the sampling-policy kill switch. `sampleRate: 0` remains
   an explicit sampling configuration and never changes the meaning of past
   events.
8. Submission is single-use. An identical retry is a no-op; a changed retry is a
   deterministic conflict. Dismissal records prompt behavior but does not revoke
   an otherwise valid invitation before expiry.
9. Invitation issuance and its cooldown claim commit atomically across streams;
   a concurrency loser reloads the claim and is suppressed deterministically.
10. Outcome code, owning source context, source entity type, and subject account id
    are validated before eligibility is written. Routes and arbitrary entity
    labels never enter the invitation stream.
11. One submitted invitation maps to one Feedback Case stream. Ratings 1 through
    3 open automatically; any submitted response can be explicitly flagged.
12. Duplicate cases keep their original response identity and point at a primary
    case. Responses and event histories are never moved, merged, or discarded.
13. Follow-up requires the response's affirmative versioned consent to remain
    active. Consent permits case-specific contact through existing contact methods
    only and is never marketing permission.
14. Every case mutation requires manager authority and records actor and action
    time in the event. View-only operators cannot dispatch case commands.

## Feedback Case Lifecycle

The case lifecycle is `new` → `triaged` → `actioned` → `closed`, with an explicit
reopen from `closed` to `triaged`. Assignment, priority, due date, and stable
support/product work references are independent operational facts. Recording a
disposition moves a triaged case to actioned; `duplicate`, `spam`, and `redacted`
are explicit dispositions and cannot enter customer follow-up. A duplicate must
reference a different primary case, so queue queries can aggregate related cases
without losing any source response.

`customer-feedback.survey.submitted` is consumed directly by the idempotent case
opening reaction. It does not define another response contract. The reaction opens
low-score responses in a deterministic per-invitation stream, while explicit flags
use the same stream and therefore preserve the one-response/one-case default under
retries and optimistic concurrency.

The old Platform Feedback `reviewed/archived` values are deliberately not imported.
They describe acknowledgement of legacy non-CSAT feedback rather than case work.
Only native Customer Feedback submission events create cases, preventing two
competing lifecycles and keeping the legacy replay classification intact.

`customer-feedback-feedback-case-projection` owns the current case row and a
stream-versioned timeline. The current row supports owner/priority/due-date queues;
the timeline preserves safe attributed event data. Customer comments remain only
in the authoritative invitation response projection and are joined for authorized
detail reads rather than copied into case events, timelines, notifications, URLs,
logs, or analytics labels.

## Invitation Projection

`customer-feedback-csat-invitation-projection` is the context's first query
projection. It owns `customer_feedback_csat_invitations`, is replay-safe through
stream-version guards, and supports account-scoped lookup by opaque public
reference plus per-subject/workflow cooldown decisions. The projection is listed
in the source-context wake registry and the push-first migration inventory.

## Recording and Analytics Projection

Presentation, dismissal, and submission are recorded through account-scoped
server operations that accept the opaque public reference and load the
authoritative survey identity from the invitation projection. Browser inputs
cannot restate workflow, outcome, account provenance, or survey identity.
Presentation and dismissal are idempotent, and a submission is single-use with
an identical retry treated as a no-op by the invitation aggregate.

`customer-feedback-csat-analytics-projection` owns
`customer_feedback_csat_analytics_facts`. It stores one row per invitation and an
independent timestamp for every lifecycle fact. `COALESCE`-based upserts make
duplicate delivery harmless and allow out-of-order lifecycle facts to converge;
there are no mutable event counters and no client-side counting.

Analytics use UTC and half-open `[from, to)` ranges. A day begins at 00:00 UTC;
a week begins Monday at 00:00 UTC. Trailing windows are the exact 7 or 30 days
ending at `asOf`, so daylight-saving changes do not add or remove an hour. CSAT
groups submissions by `submittedAt`. Response rate is presentation-cohort based:
the denominator is unique invitations presented in the interval, and the
numerator is those same invitations with a valid submission before the interval
end. This keeps a submission for an invitation presented before the interval out
of the interval's numerator and prevents rates above 100%.

Native submissions without a presentation are rejected by the aggregate. During
out-of-order projection delivery, a temporarily observed submission without its
presentation is excluded from the response numerator and reported as a
denominator anomaly until replay converges. Legacy generic feedback and any
unregistered or non-CSAT instrument are excluded structurally.

Filtered analytics are bounded to 366 days and support deterministic UTC
daily/weekly keyset pagination by bucket start. Supported dimensions are exact
survey version, workflow outcome, customer role, and persisted sampling cohort.
Device and delivery channel are intentionally absent until a lifecycle contract
legitimately records them. Query results expose zero-denominator,
insufficient-sample, incomplete, and stale availability states, plus projection
lag/rejected-event inputs from the generic projection runtime, denominator
anomalies, and invitation-to-submission latency.

Partial composite indexes for each lifecycle timestamp begin with the compatible
survey identity and let PostgreSQL combine the bounded lifecycle predicates with
bitmap-OR plans; the dimension index narrows workflow, role, and cohort filters.
The query returns only invitation-unique facts and sorts by invitation id before
bucket aggregation, so planner choice cannot change output order.

## Tests

Run `pnpm --filter @chase-sets/customer-feedback run test:watch` for the sub-second
watch-mode inner loop. Run `pnpm --filter @chase-sets/customer-feedback run test`
before opening a PR.
