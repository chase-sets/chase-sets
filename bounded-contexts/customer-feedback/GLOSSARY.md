# Customer Feedback Domain Glossary

This file is the canonical terminology for the Customer Feedback bounded context.

The context is named **Customer Feedback** — the ubiquitous language for the
capability that owns customer-satisfaction capture. It deliberately is **not**
Support, Platform Operations, or Notifications: those contexts own, respectively,
support cases, operational projections, and delivery channels. Customer Feedback
owns survey instruments, invitations, responses, satisfaction analytics, and
feedback cases.

## Customer Satisfaction

**Customer Satisfaction** (CSAT) is the transactional measure of how satisfied a
customer was with a specific completed experience. It is calculated as submitted
ratings of 4 or 5 divided by all submitted ratings for the same survey version and
filter set, over trailing 7-day and 30-day windows.

Notes:

- An average star rating is **not** CSAT. CSAT is the satisfied share (4–5) of a
  single comparable survey instrument version.
- Generic experience feedback and any future CES, NPS, experience-pulse, or
  public-review instrument must never be mixed into the CSAT numerator or
  denominator.

## CSAT Survey

A **CSAT Survey** is a versioned survey instrument owned by Customer Feedback. The
launch instrument asks a single anchored question — "How satisfied were you with
this experience?" — on a 1–5 scale with visible endpoint anchors and no
preselected answer.

Notes:

- A survey has a `surveyKind` (`transactional-csat` or `legacy-experience-rating`)
  and a `surveyVersion` / `questionVersion` identity.
- Only `transactional-csat` surveys are CSAT-eligible.

## Survey

**Survey** is the event-contract noun for a versioned Customer Feedback
instrument and its submitted answer. The launch survey is the CSAT Survey; the
generic event noun leaves room for separately versioned future instruments
without treating them as CSAT.

## Survey Version

A **Survey Version** is the full `(surveyKind, surveyVersion, questionVersion)`
identity that every response is pinned to. Two responses are combinable into one
CSAT figure only when they share the identical `transactional-csat` survey version.

## CSAT Invitation

A **CSAT Invitation** is the server-controlled aggregate that redeems a
source-context Outcome Fact and may issue an opaque public reference to a subject.
It carries authoritative provenance and is never created from client-supplied
workflow, route, entity, account, or subject claims.

Notes:

- Lifecycle states: `eligible` → `issued` → `presented` → `submitted`, with
  `dismissed`, `expired`, `suppressed`, and `revoked` closure paths. A dismissed
  invitation remains redeemable until expiry or revocation.
- The public reference is unguessable and distinct from the aggregate id.
- Each outcome code has an invitation-owned allow-list of source entity types;
  route strings and arbitrary entity labels are rejected before eligibility.
- Submission is single-use and idempotent for an identical retry.
- Presented and submitted invitations are the denominator and numerator of the
  response rate.

## CSAT Response

A **CSAT Response** is a submitted survey answer: a 1–5 rating, an optional
comment, and separately versioned follow-up consent, tied to the invitation and
its survey version.

## Feedback Case

A **Feedback Case** is the event-sourced operational lifecycle opened from one
immutable CSAT Response. It moves through `new`, `triaged`, `actioned`, and
`closed`, with explicit reopen. Ownership, priority, due date, disposition,
linked work, and follow-up are attributed case facts; they never modify the
customer response.

Ratings from 1 through 3 open a case automatically. A manager may explicitly
flag any submitted response. Both paths use the same per-invitation stream, so one
response maps to one case by default.

## Case

**Case** is the short event noun for a Feedback Case. It is always scoped by the
Customer Feedback context and never means a generic support ticket.

## Feedback Attention

**Feedback Attention** is the active, explainable operator signal for a low-score
or reopened Feedback Case. Its rule version is recorded with the signal so later
policy changes do not rewrite historical classification.

## Triage SLA

A **Triage SLA** is the bounded time from case opening to triage. Its due time is
derived from the versioned attention policy and case priority; a case can also
carry a separate operator due date.

## Staff Attention Digest

A **Staff Attention Digest** is a bounded, deduplicated time-window summary of
Feedback Attention items grouped by operator team. It contains authorized case
links and operational metadata, never customer comments.

## Feedback Case Disposition

A **Feedback Case Disposition** records the operational outcome that makes a
triaged case actioned. Supported outcomes include support resolution, product
change, customer education, no action, duplicate, spam, and redacted. A duplicate
case references its primary case but retains its own response and history.

## Feedback Case Follow-up

**Feedback Case Follow-up** is case-specific customer contact through an existing
contact method. It can be requested and sent only while the response's affirmative
versioned consent remains applicable. The consent is not marketing permission;
withdrawal cancels pending follow-up, and duplicate, spam, or redacted cases cannot
use it.

## Workflow Outcome Code

A **Workflow Outcome Code** is a stable, allow-listed identifier for the customer
outcome a survey is anchored to (for example `checkout.recovered`,
`order.delivered`, `payout.completed`). The allow-list is the authority that
prevents arbitrary client-claimed workflows; each code is owned by exactly one
source context.

## Outcome Fact

An **Outcome Fact** is the versioned, server-authoritative record a source context
publishes when it completes an outcome it owns. Customer Feedback consumes Outcome
Facts to decide whether to issue an invitation; it never reaches into another
context's aggregate or database.

## Sampling Policy

A **Sampling Policy** decides which eligible outcomes receive a survey and records
the complete deterministic decision: policy/schema id, algorithm version, cohort,
bucket, sample rate, inclusion, and reason. `issuanceEnabled` is the explicit kill
switch; `sampleRate: 0` is not overloaded as one. The policy also defines the
per-subject cooldown and invitation expiry interval. Launch sampling never depends
on post-launch beta cohorts or feature flags.

## Response Rate

**Response Rate** is unique submitted invitations divided by unique presented
invitations, over the trailing 7-day and 30-day windows.

The denominator is a presentation cohort in a half-open UTC interval. The
numerator is the subset of those same invitations submitted before the interval
ends. A submission whose presentation belongs to an earlier interval does not
enter the current interval's numerator.

## CSAT Analytics Fact

A **CSAT Analytics Fact** is the replayable, invitation-unique read-model row that
records independently observed eligibility, issuance, presentation, dismissal,
expiry, and submission timestamps plus the submitted rating and authoritative
dimensions. Duplicate and out-of-order lifecycle delivery converges on the same
row without incrementing counters.

## Legacy Experience Rating

A **Legacy Experience Rating** is a pre-existing generic 1–5 platform-feedback
submission, reclassified under the explicit non-CSAT
`legacy-experience-rating` survey kind. This is the migrate-not-reset decision:
legacy events stay replayable, and their ratings can never enter CSAT because the
kind is not CSAT-eligible.
