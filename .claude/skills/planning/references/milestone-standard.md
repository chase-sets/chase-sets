# Milestone Standard — the outcome container

Milestones are few and **outcome-oriented**: each states a user- or
operator-visible outcome and a date. A milestone is a **time horizon** — never a
theme, a component list, or a parallel track. Prefer placing new work into an
existing milestone; mint a new one only when no current milestone owns the
outcome.

Structure contract: `docs/contributing/backlog-model.md`.

Three milestones are not waves and never enter the executable queue:
`Deferred / Incubation` (explicitly parked), `Operations` (machine-generated
incidents, ops alerts, delivery-health signals), and — by absence — **no
milestone at all, which means exactly one thing: needs triage**. Never leave
real work unmilestoned to mean "later"; that is what `Deferred / Incubation` is
for.

## Description fields

- **Outcome.** One or two sentences: what is true for users/operators when this
  closes. If you can't state it without listing components, it's a theme, not a
  milestone — recut it.
- **Scope boundary.** What this milestone explicitly does NOT cover, and which
  milestone covers it instead.
- **Entry gates.** Milestones/decisions that must land first.
- **Exit criteria.** The evidence that proves the outcome (beyond "all issues
  closed") — a verifier, a UAT flow, a metric.
- **Track placement.** Where it sits in the program order (tracking issue),
  and any deadline.

## Rules

- One epic per coherent feature inside the milestone; small standalone slices
  may attach directly without an epic.
- A milestone closes when all non-parked children close AND exit-criteria
  evidence is linked from the closing comment.
- Reprioritization is a tracking-issue comment plus milestone description
  update — parked children move out (to a parked milestone or closed
  as-superseded) rather than lingering.
- A milestone that cannot finish inside its horizon is **split at planning
  time**, not at the deadline. If the split lines are not real, move the date
  instead — renaming buckets is not scheduling. Watch for the dumping-ground
  shape: one wave holding a third of the backlog under a single date.
- Never hand-maintain issue counts in a milestone description or roadmap issue.
  `scripts/roadmap-status.mjs` generates them; a hand-typed rollup drifted on
  5 of 12 rows in two weeks.
