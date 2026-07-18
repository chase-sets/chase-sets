# Epic Standard — the orchestrator handoff

An epic is the coordination artifact for a multi-slice feature. Its body is
**write-once**: corrections and rulings land as superseding comments, never
edits — the comment trail is the audit log. Use the `epic` issue form.

## Body sections

- **Outcome.** What ships when every child closes; how it serves the owning
  milestone's outcome.
- **Orchestrator handoff.** The load-bearing section:
  - **Chain DAG / waves.** Which children are serial (shared footprints, in
    order) and which parallelize (disjoint footprints). Explicit issue-number
    chains: `#A → #B → #C; #D, #E parallel after #B`.
  - **Gates.** What must be true before wave N (other milestones, decisions,
    infra).
  - **Parked.** Children deliberately deferred, with the un-park condition.
  - **Decision registry.** Open decisions this epic waits on, linked to their
    decision issues.
- **Child index.** One line per child: number, title, chain position.

## Rules

- Every child meets the issue standard before the epic is considered planned.
- Evidence and review passes live in child issues/PRs — never relocated into
  epic or milestone comments (anti-ratchet).
- A superseding comment names what it supersedes ("supersedes the wave-2
  ordering above").
- When scope genuinely grows: new child issue (fixed scope) + a superseding
  comment adding it to the DAG — never a rewrite of the body.
