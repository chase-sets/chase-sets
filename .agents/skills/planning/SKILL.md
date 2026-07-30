---
name: planning
description: Plan Chase Sets work from a feature idea or problem statement — calibrate scope to issues, an epic, or a milestone, then produce lane-ready artifacts (dispatch-brief issues, orchestrator-handoff epics, outcome milestones) with decisions extracted up front and plans pressure-tested. Use when planning a feature, scoping a problem, breaking down work, or authoring issues, epics, or milestones.
---

# Planning

Turn an idea or problem into artifacts a dispatched lane can implement correctly
the first time. First-time-right has two ingredients: **self-contained context**
(a fresh worker needs nothing from this conversation) and **decisions extracted
before dispatch** (a decision surfaced at planning time costs nothing; the same
decision surfaced mid-lane stalls the lane).

References (load only what the tier needs):
`references/issue-standard.md` · `references/epic-standard.md` ·
`references/milestone-standard.md` · `references/pressure-test.md`

The structure every artifact lands in — the strategy/wave/epic/slice ladder,
what each GitHub primitive means, the label charter, and refined-vs-backlog —
is `docs/contributing/backlog-model.md`. Read it before minting a milestone,
an epic, or a label.

## Stage 0 — Scope calibration

Size the idea against the existing structure before assuming a tier. Placement
into **existing homes is the default**; minting a new milestone is the exception
and needs a reason (milestones are few and outcome-oriented on purpose).

| Tier | Signals | Produce |
|---|---|---|
| **Issues** (1–N) | One context, at most a short chain, fits an existing milestone's outcome | Issues into that milestone; no epic ceremony |
| **Epic** | Coherent feature needing sequenced slices/waves, still serving an existing milestone outcome | Epic + child issues inside it |
| **Milestone** | A genuinely new outcome no current milestone owns; gates, track placement | Milestone + epic + issues, full pipeline |

Calibration may revise itself mid-flight: when an issue-sized idea grows a second
context or a full-path trigger during discovery, escalate the tier — start small,
escalate the moment scope demands it.

## Pipeline

Stages by tier — Issues: 1, 2-light, 5, 7 · Epic: 1–5, 6-light, 7 · Milestone: all.

1. **Intake.** Outcome statement, why-now, constraints, and (milestone tier)
   track placement plus entry/exit gates against other milestones.
2. **Discovery.** Repo evidence sweep: owning contexts' README/GLOSSARY, prior
   art, and an explicit **don't-rebuild check** — shipped surfaces get pointers,
   never reimplementation. Check glossary conformance of every term the plan
   introduces. Query the orchestrator ledgers with the outcome, domain terms,
   and predicted footprint:

   ```powershell
   pwsh -NoProfile -File ~/.claude/skills/milestone-orchestrator/scripts/query-ledgers.ps1 -Mode implementation -Text "<outcome and domain terms>" -Footprint "<predicted paths>"
   ```

   Write each returned defect constraint into the issue text itself. Never load
   the complete ledgers during normal planning; search a named entry only when
   retrieval points to it or when auditing retrieval coverage. Heavy discovery
   fans out to research workers; the planner synthesizes.
3. **Decomposition.** Vertical slices, one behavior owner each. **Footprint
   analysis drives topology:** slices sharing files form declared serial chains;
   disjoint slices form parallel waves. Declare the chain DAG explicitly — this
   is what lets the orchestrator parallelize lanes safely.
4. **Decision extraction.** Enumerate every decision the work will hit. Resolve
   what repo evidence can; everything else goes to the decision queue NOW, each
   with a recommendation — never leave a known decision to surface mid-lane.
   Issues behind an unresolved decision are created blocked, linked to it.
   Route every authority-timing uncertainty (will this AC's data exist from
   the external authority at the moment implementation needs it?) to a
   probe-now step instead of letting it surface as a mid-lane discovery
   (`references/issue-standard.md` item 8).
5. **Drafting.** Author artifacts per the reference standards. Every path
   terminates in issues meeting `references/issue-standard.md`, whatever the tier.
6. **Pressure test.** Adversarial pass in a FRESH context (independent agent)
   per `references/pressure-test.md`. Repair findings before registration.
7. **Registration.** Create on GitHub (issue forms under `.github/ISSUE_TEMPLATE/`)
   and wire the structure natively — prose is not structure:
   - every child **attached as a sub-issue** of its epic (one parent per slice);
   - every chain link recorded as a **GitHub issue dependency**, not only as a
     `Blocked by #N` line;
   - every open slice classified (`refined ≡ classified`) with a wave milestone
     + `priority:*` + `area:*` + `kind:*`, excluding Epics,
     `status:tracking-only`, `Deferred / Incubation`, and `Operations` (the
     slice form's dropdowns set the labels; API-created issues must set type and
     labels explicitly);
   - parent attachment is reported, not gating: attach a slice to the Epic that
     owns its acceptance when one exists. A future parent-or-standalone gate
     and any `status:standalone` label require a new fixed-scope change;
     [#6174](https://github.com/chase-sets/chase-sets/issues/6174) records that
     this is not current behavior;
   - **no new label** unless it fits the four families in the backlog model.
     Sequencing inside a workstream is the epic's chain DAG — `phase:*`,
     `stage:*`, `series:*`, and `tier:*` families are banned, having produced
     55 dead labels across finished milestones.

   Then comment placement into the program tracking issue and hand off to the
   orchestrator. Never hand-type rollup counts anywhere;
   `scripts/roadmap-status.mjs` generates them.

## Replan intake — planning an issue whose implementation stopped

Most planning starts from an idea. This branch starts from a failure: an issue
labeled `status:needs-replan` whose PR was closed unmerged. It is **active
recovery work, not parked work**, and the accumulated review findings are the
most valuable input you will get — a replacement that does not answer them
fails the same way. Lane dispatches carry the orchestrator's planning-repair
contract (`planning-repair/v1`) automatically; solo sessions follow the same
shape.

Before Stage 1, gather and state: the closed PR with its **exact head and
branch** (read-only salvage), every blocking finding ID from the reviews that
stopped it, the decision issues that governed it and how each resolved, and
current `origin/main` — the findings were written against a head that has moved.

Then run the normal pipeline with three changes:

- **Discovery is a don't-rebuild check first.** Search for replacements filed
  for *sibling* issues; adjacency is not coverage. #6105 and #6106 replaced
  #6058, and reading them as covering #5684 would have silently dropped consent
  bundle content, activation authority, and the affirmation UI.
- **Decomposition answers the findings explicitly.** Each blocking finding maps
  to a slice, an accepted constraint written into the issue text, or a stated
  reason it no longer applies at current main.
- **The pressure test is mandatory**, not tier-dependent. This plan already
  failed once.

Terminate in exactly one disposition:

| Disposition | When | Effect on the original |
|---|---|---|
| `REPAIR_IN_PLACE` | outcome, decisions, and acceptance semantics all unchanged; the brief was merely imprecise | rewritten in place, stays runnable |
| `REPLACED` | anything else — the normal outcome | relabel `status:tracking-only`, link every replacement, stays **open** until they land |
| `RECOMMEND_NOT_COMPLETING` | the work should not be done at all | stays open; only Todd may close it |

`PARKED` is not a disposition. Never amend new requirements into the original;
a genuinely new gap is a new fixed-scope issue. Never mark a replacement
runnable before it passes the definition-of-ready checklist — filing an unready
replacement moves the failure rather than fixing it.

## Enforcement — definition of ready

The milestone orchestrator runs the trusted-default-branch
`.github/workflows/issue-readiness.yml` only for the issue being considered and
consumes that run's exact `issue-readiness/v1` artifact through
`consumeIssueReadinessReceipt()` in `scripts/issue-readiness.mjs`. Missing,
malformed, stale, and `unknown` receipts are rejected; `not-ready` routes to a
planning-repair pass. The stable issue comment is operator-facing history, not
dispatch authority. Invoke the workflow at the repository default-branch ref;
the workflow rejects every other ref before loading the checker.

The machine receipt proves only the structural rules in
`references/issue-standard.md`. The independent semantic pressure test remains
separate and can reject a structurally `ready` issue; the consumer represents
that result as planning repair without rewriting the receipt.

Retrofit policy: apply to new planning and to issues at dispatch time. Do not
mass-rewrite the existing corpus (anti-ratchet); it converges lazily,
highest-traffic first.

## Routing

Calibration, decomposition, decision extraction, and synthesis are frontier-
judgment work (model-routing row 8). Discovery sweeps and drafting mechanics go
to cheap workers. The pressure test runs on an independent capable model, never
the one that wrote the plan. Always route by exact model version; a successor is
a new model with new evidence, and predecessor vetoes or scores never transfer.
