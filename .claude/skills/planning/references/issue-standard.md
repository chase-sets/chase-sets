# Issue Standard — the dispatch brief

An issue is a dispatch brief: everything a fresh worker needs, nothing it must
ask for. A worker with zero conversation context should be able to implement it
correctly the first time. Use the `slice` issue form (`.github/ISSUE_TEMPLATE/`).

## Sections

- **Context.** Why this exists; links to epic/ADR; and 2–5 **repo evidence
  pointers** (file paths, symbols, prior art). Workers rediscovering the
  codebase is the main token sink and the main source of wrong-guess rework.
- **Scope fence.** What is in; what is explicitly out. Non-goals prevent scope
  creep and anti-ratchet violations.
- **Decisions already made.** Settled rulings with links (ADR, epic comment,
  decision issue). A worker never re-litigates a settled decision; a worker who
  hits an UNsettled one stops and escalates (see the delivery skill).
- **Acceptance criteria — each with its evidence method.** Every AC names how it
  is proven: a test name, a verifier script, a screenshot, an ops check. This is
  also the Closes-automation defense: structured ACs are what the orchestrator's
  bookkeeping verifies before treating the issue as done. An AC whose contract
  must be accepted by an **external provider** (payment-provider event sets,
  webhook payloads, third-party API schemas) names the provider's **test-mode
  surface** as its evidence method — internal consistency has passed every
  internal gate and still been rejected live (#5811). An AC whose acceptance
  depends on data produced FROM an external authority (GitHub API shapes,
  provider payloads, queue/webhook associations, cloud-API state) names a
  **captured probe** as its evidence method: live call output, or a durable
  link/fixture, taken at the exact lifecycle moment the implementation needs
  the data. Endpoint/docs existence and post-hoc replay do not qualify — PR
  #5883 needed five-plus repair rounds because `actions/runs.pull_requests`
  is empty while a merge-group run is queued and populates only after merge
  (live run 29888165410 confirmed `pull_requests: []` mid-queue); the defect
  was invisible to every check except a probe taken at that exact moment.
- **Verification plan.** The scoped commands that prove the change
  (`pnpm --filter <workspace> run test`, guards, e2e batch if UI).
- **Review packet seed (full path).** Name the invariants and likely failure
  modes the independent reviewer must attack, plus the evidence artifact that
  exposes omissions invisible in the diff (state enumeration, caller inventory,
  authority probe, provider test-mode result). This is a focused attack surface,
  not a restated checklist.
- **Predicted footprint.** Workspaces/files the change will touch, plus chain
  position. Record chain links as **native GitHub issue dependencies**
  (Blocked by / Blocks); the prose `Blocked by #N` line is a convenience mirror
  and the relationship is what the orchestrator reads. Feeds parallel-lane
  collision checks.
  When the change adds validation or invariants to a handler that seed,
  bootstrap, import, or reconciliation paths also invoke, the footprint
  enumerates **every caller** — the sibling-seed-path class is the ledger's top
  re-biter and its root cause is an incomplete caller inventory.
  Include any **operator actions** the work will need — credentials, sign-ins,
  approvals, live watch windows — or state `Operator actions: none`. An
  operator dependency discovered mid-lane stalls delivery on human latency;
  enumerated actions let the orchestrator batch a single operator session and
  dispatch operator-dependent work only into a signaled window.
- **Tier + routing hint.** Fast or full path (blast radius), and
  presentation-vs-system for lane assignment.

## Definition of ready (the dispatch gate)

The orchestrator dispatches an issue only when ALL hold:

0. **Placed and classified:** a native **issue type** (`Slice`, `Bug`,
   `Decision`, `Probe` — `Epic` is never dispatchable), one wave milestone,
   `priority:*`, `area:*`, `kind:*`, and — when the slice belongs to a
   capability — attached as a **sub-issue of its epic**. The slice form applies
   the labels from its dropdowns (`scripts/issue-form-labels.mjs`); issues
   created by API must set type and labels explicitly. An unclassified slice is
   backlog, not a dispatch candidate: it cannot be ranked, collision-checked,
   or rolled up.
1. Repo evidence pointers present (≥2) and non-generic.
2. Scope fence states at least one explicit non-goal.
3. Every AC has an evidence method; external-provider contracts name the
   provider's test-mode surface.
4. Verification plan names runnable scoped commands.
5. Footprint predicted — including every caller of any touched shared
   handler; chain links wired if any; operator actions (credentials, sign-ins,
   approvals, live watch windows) enumerated — explicitly `none` when there
   are none.
6. No unresolved full-path decision — or the issue is explicitly linked
   `Blocked by` the decision issue.
7. Terms conform to the owning context's glossary; new terms are registered.
8. Every AC depending on an external authority embeds its captured probe (or
   a link to one) taken at the exact lifecycle moment the implementation
   needs the data — not endpoint/docs existence, not a post-hoc replay
   (#5883).
9. Full-path work includes a review packet seed naming its invariants, likely
   failure modes, and omission-revealing evidence.

Fails → planning-repair pass, not an implementation lane.

## Rules

- New gap discovered mid-work = a NEW fixed-scope issue (this standard applies);
  never amend requirements into an existing issue.
- Titles: verb + outcome, ubiquitous language, no codenames.
- Evidence lives in the issue/PR, never in committed docs.
