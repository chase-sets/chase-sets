# Customer Feedback Domain Glossary

This file is the canonical terminology for the Customer Feedback bounded context.

The context is named **Customer Feedback** — the ubiquitous language for the
capability that owns customer-satisfaction capture. It deliberately is **not**
Support, Platform Operations, or Notifications: those contexts own, respectively,
support cases, operational projections, and delivery channels. Customer Feedback
owns survey instruments, invitations, responses, and satisfaction analytics.

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

## Legacy Experience Rating

A **Legacy Experience Rating** is a pre-existing generic 1–5 platform-feedback
submission, reclassified under the explicit non-CSAT
`legacy-experience-rating` survey kind. This is the migrate-not-reset decision:
legacy events stay replayable, and their ratings can never enter CSAT because the
kind is not CSAT-eligible.
