# Milestone Standard — a finite outcome

Use `docs/contributing/backlog-model.md` for the authority and ordering contract.
Agents own milestone creation, placement, promotion, splitting and priority.
Todd supplies steering overrides; never ask him to classify routine work.

Prefer an existing outcome only when it actually requires the issue's
acceptance. A shared theme or bounded context is not sufficient. Create a new
committed milestone when a distinct, approved, independently usable outcome
needs its own finish line. Keep future themes in candidate milestones until an
agent selects a bounded deliverable. Do not park implementation recovery.

## Description

Include:

- **Outcome and owner:** what becomes true for users/operators and which
  capability owns acceptance.
- **Scope boundary:** required behavior and explicit exclusions, with a named
  destination for future work.
- **Entry conditions:** genuine prerequisites represented by native issue
  dependencies, including provider and operator lifecycle conditions.
- **Exit gates:** current terminal evidence issue references in an `Exit gates:`
  clause ending before `Canonical sequencing:`. Put history and decision
  references outside the clause. A percentage or an empty issue list is not
  evidence of the outcome.
- **Order:** one valid `outcome` metadata comment with agent-selected track,
  sparse order and committed/candidate status, per the shared policy.
- **Placement reason:** why this outcome is selected now, any scope tradeoff,
  and applicable steering, recorded on the program roadmap.

Keep open milestone due dates null. Put an actual external date on its owning
gate issue; never create dates to force display or dispatch order.

## Lifecycle

At intake, identify observable acceptance, attach the owning Epic when one
exists, and place the slice in the committed outcome that needs it. Epics stay
unmilestoned. Parent attachment is reported, not a dispatch gate.

Promote candidate work only as a bounded usable outcome with explicit gates.
Rank by steering, correctness, gate-unblocking value, evidenced complete-outcome
benefit/effort, readiness and age. Missing evidence does not require a Todd
placement decision and must not become an invented impact score.

Close a committed milestone only after its admitted acceptance and terminal
evidence pass. Reconcile required tracking records and give optional remainder
an explicit destination before closure. Preserve successor links and active
work; closing a gate never silently cancels other admitted acceptance.

Register material changes in the roadmap. Never hand-maintain progress counts;
`scripts/roadmap-status.mjs` owns generated status. Refresh finite commitments
rather than repeatedly appending adjacent improvements to the earliest wave.
