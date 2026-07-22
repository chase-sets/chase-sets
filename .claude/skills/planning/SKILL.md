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
   introduces. Sweep the orchestrator's **defect-class ledger**
   (`~/.claude/skills/milestone-orchestrator/references/defect-classes.md`):
   any class whose territory overlaps the planned footprint gets its constraint
   written into the issue text itself — dispatch-time pasting alone has not
   stopped re-bites (the top class re-bit 7× in one 14-day window), and issues
   delivered solo never see the dispatch prompt at all. Heavy discovery fans
   out to research workers; the planner synthesizes.
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
7. **Registration.** Create on GitHub (issue forms under `.github/ISSUE_TEMPLATE/`),
   wire blocked-by links, comment placement into the program tracking issue, and
   hand off to the orchestrator.

## Enforcement — definition of ready

The milestone orchestrator dispatches only issues that pass the
definition-of-ready checklist in `references/issue-standard.md`. An issue that
fails the gate is not dispatched to implementation; it gets a planning-repair
pass first. Standards without enforcement rot — the gate is the standard.

Retrofit policy: apply to new planning and to issues at dispatch time. Do not
mass-rewrite the existing corpus (anti-ratchet); it converges lazily,
highest-traffic first.

## Routing

Calibration, decomposition, decision extraction, and synthesis are frontier-
judgment work (model-routing row 8). Discovery sweeps and drafting mechanics go
to cheap workers. The pressure test runs on an independent capable model, never
the one that wrote the plan.
