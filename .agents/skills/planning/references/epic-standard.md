# Epic Standard — the orchestrator handoff

An epic is the coordination artifact for a multi-slice feature. Its body is
**write-once**: corrections and rulings land as superseding comments, never
edits — the comment trail is the audit log. Use the `epic` issue form, which
sets the native **Epic** issue type; that type is what marks the issue
non-dispatchable, not the legacy `kind:epic` label.

Structure contract: `docs/contributing/backlog-model.md`.

**Children are native GitHub sub-issues.** Link every child with the sub-issue
relationship at registration. GitHub computes epic progress and roll-up from
those links and cannot see prose; where the written Child index and the links
disagree, the links are authoritative. Epics stay unmilestoned — they span waves
by design.

## Body sections

- **Outcome.** What ships when every child closes; how it serves the owning
  milestone's outcome. Name the strategy pillar it serves:
  `Serves: <pillar> — <wave>`.
- **Orchestrator handoff.** The load-bearing section:
  - **Chain DAG / waves.** Which children are serial (shared footprints, in
    order) and which parallelize (disjoint footprints). Explicit issue-number
    chains: `#A → #B → #C; #D, #E parallel after #B`.
  - **Gates.** What must be true before wave N (other milestones, decisions,
    infra).
  - **Parked.** Children deliberately deferred, with the un-park condition.
  - **Decision registry.** Open decisions this epic waits on, linked to their
    decision issues.
- **Child index.** One line per child: number, title, chain position. This is a
  human-readable mirror of the sub-issue links, not a substitute for them.

## Rules

- Every child meets the issue standard before the epic is considered planned.
- Every child is attached as a sub-issue. A child that exists only in the prose
  index is invisible to roll-up and to the orchestrator.
- One parent per slice (GitHub allows exactly one). A slice serving two epics
  belongs to the one that owns its **acceptance**; the other references it.
- Evidence and review passes live in child issues/PRs — never relocated into
  epic or milestone comments (anti-ratchet).
- A superseding comment names what it supersedes ("supersedes the wave-2
  ordering above").
- When scope genuinely grows: new child issue (fixed scope) + a superseding
  comment adding it to the DAG — never a rewrite of the body.
