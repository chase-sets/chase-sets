# Customer Feedback Bounded Context

## Purpose

Customer Feedback is the canonical home for customer-satisfaction capture. It owns
survey instruments and versions, invitation/eligibility/sampling/presentation,
survey responses, CSAT and response-rate analytics, and feedback privacy semantics.
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
- The CSAT and response-rate calculation contract and their operating windows.
- The migrate-not-reset legacy classification and the replay-compatibility base.

## Does Not Own

- Projecting aggregate CSAT/response-rate analytics and composing the survey UI
  (#5148); the invitation query projection belongs to this lifecycle slice.
- The closed-loop feedback case lifecycle and operator UI (#5149/#5153/#5154).
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

## Invitation Projection

`customer-feedback-csat-invitation-projection` is the context's first query
projection. It owns `customer_feedback_csat_invitations`, is replay-safe through
stream-version guards, and supports account-scoped lookup by opaque public
reference plus per-subject/workflow cooldown decisions. The projection is listed
in the source-context wake registry and the push-first migration inventory.

## Tests

Run `pnpm --filter @chase-sets/customer-feedback run test:watch` for the sub-second
watch-mode inner loop. Run `pnpm --filter @chase-sets/customer-feedback run test`
before opening a PR.
