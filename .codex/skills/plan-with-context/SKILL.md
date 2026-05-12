---
name: plan-with-context
description: Plan implementation or product features against the Chase Sets bounded-context model, ubiquitous language, code, and docs. Use when the user wants one-question-at-a-time planning with recommended answers, code/doc cross-checks, a working plan under .codex/plans, mobile and desktop visual verification, and durable updates to owning glossaries, context docs, or ADRs.
---

# Plan With Context

Pressure-test a plan against the repo's domain model. Ask one question at a time, recommend an answer, verify anything discoverable from code/docs before asking, keep a temporary plan current, and promote durable context into canonical docs as soon as it settles.

## Repo Map

- Context map: `bounded-contexts/README.md`.
- Context sources of truth: `bounded-contexts/<context>/README.md`, `GLOSSARY.md`, and `context.json`.
- Structure rules: `docs/architecture/bounded-context-structure.md`.
- Cross-context docs: `docs/`.
- Cross-context glossary index: `docs/GLOSSARY.md`; add local terms to owning context glossaries first.
- Context-owned notes and modeling docs: `bounded-contexts/<context>/docs/`.
- System ADRs: `docs/adr/`.
- Do not create or rely on `CONTEXT.md` or `CONTEXT-MAP.md` in this repo.

## Workflow

1. Identify likely owning context(s).
2. Read the repo map files plus each candidate context's `README.md`, `GLOSSARY.md`, and `context.json`.
3. Search code for relevant terms, events, routes, IDs, projections, UI labels, and tests before asking answerable questions.
4. Create or update `.codex/plans/<feature-slug>.md`.
5. Ask the next blocking question with the decision, why it matters, recommended answer, repo evidence, and consequence of choosing differently.
6. After each answer or finding, update the plan and immediately promote durable terms or decisions to canonical docs.

Walk questions in dependency order: ownership, language, invariants, events, read models, APIs, UI, operations.

## Working Plan

Use `.codex/plans/<feature-slug>.md` as disposable memory for compaction, handoff, and optional `/goal` tracking. Keep it in dependency order and include only sections that are useful:

```markdown
# <Feature>

## Intent
## Owning Contexts
## Resolved Decisions
## Open Questions
## Implementation Checklist
## Documentation To Promote
## Cleanup Criteria
```

Update the plan after every answered question, repo finding, accepted/rejected recommendation, and doc change. `Cleanup Criteria` must list what durable context must survive after the plan is deleted.

If the user explicitly asks for `/goal`, create a goal whose objective references the plan path. Treat unchecked items, unresolved questions, failing automated checks, missing mobile/desktop visual verification, unpromoted durable context, and the still-present plan file as blockers to completion.

## Planning Rules

- Ask exactly one question at a time and wait for feedback.
- Resolve questions from code/docs yourself when possible.
- Call out glossary conflicts immediately.
- Propose a canonical term and owning context for vague or overloaded language.
- Stress-test abstractions with scenarios covering normal flow, partial/multi-party flow, stale data or replay, cross-context handoff, failure/cancellation, and low-value card economics when relevant.
- Tie every cross-context interaction to one behavior owner and a stable published fact.
- Surface contradictions between the plan, docs, and code before continuing.

## Where To Look

- Owning context: `features/*/{domain,read-model,api,ui,integrations}`, `routes/`, `support/*-support/`, and tests.
- Cross-context surface: `contracts/` for primitives, typed IDs, and integration events.
- Shared technical adapters: `infrastructure/`.
- Composition roots only: `deployables/`.

## Documentation Destinations

- Local term: `bounded-contexts/<context>/GLOSSARY.md`.
- Cross-context term index: `docs/GLOSSARY.md`.
- Context policy/modeling note: `bounded-contexts/<context>/docs/<topic>.md`.
- System-wide decision: `docs/adr/<next-number>-<slug>.md`.
- Cross-cutting architecture: `docs/architecture/<topic>.md`.
- API docs: `docs/api/`.
- Runbooks: `docs/runbooks/`.
- Design-system patterns: `packages/design-system/`.

Update `docs/README.md` when adding durable owner-owned docs that should appear in the curated map.

Offer an ADR only when the choice is hard to reverse, surprising without context, and the result of a real trade-off. Prefer context docs for context-local decisions.

## Cleanup

Before pausing, report the plan path, resolved decisions, docs updated, contradictions found, and next unresolved question.

Before completion, visually verify the result in mobile and desktop viewports. For non-UI work, verify the nearest visible result, such as generated docs, API output, logs, or an operator page.

When the feature is done, reread the plan, promote remaining durable context, pass automated checks, pass mobile/desktop visual verification, delete `.codex/plans/<feature-slug>.md`, remove `.codex/plans/` if empty, and summarize the durable docs that remain.
