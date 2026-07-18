# Milestone Standard — the outcome container

Milestones are few and **outcome-oriented**: each states a user- or
operator-visible outcome, not a theme or a component list. Prefer placing new
work into an existing milestone; mint a new one only when no current milestone
owns the outcome.

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
