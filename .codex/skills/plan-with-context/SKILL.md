---
name: plan-with-context
description: Plan implementation or product features against the Chase Sets bounded-context model, ubiquitous language, code, and docs. Use when the user asks to plan or implement a feature with one-question-at-a-time prompts, recommended answers, code/doc cross-checks, plan/doc creation, goal creation, and no product code changes during planning.
---

# Plan With Context

Plan a feature against the repo's domain model. In this skill, "implement" means collect decisions, write planning artifacts/docs, and create a goal for implementation; do not change product code.

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
5. Ask the next blocking question with the decision, why it matters, recommended answer, repo evidence, and consequence of choosing differently. Use interactive `request_user_input` prompts when available; otherwise ask in plain text.
6. After each answer or finding, update the plan and any already-settled docs.
7. When planning is complete, create a `/goal` whose objective references the plan path and owns implementation, durable doc promotion, verification, visual checks, and plan cleanup.

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

Update the plan after every answered question, repo finding, accepted/rejected recommendation, and doc change. `Cleanup Criteria` must list what the later implementation goal must verify, promote, and clean up.

Treat "Use `$plan-with-context` to implement <feature>" as an explicit request to create the implementation goal after planning. If goal tooling is unavailable, write the exact goal prompt into the plan and tell the user.

## Planning Rules

- Ask exactly one question at a time and wait for feedback.
- Resolve questions from code/docs yourself when possible.
- Do not edit product code, runtime code, schemas, tests, or UI during this skill.
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

This skill is complete when the plan/docs are written and the implementation goal exists. The goal is complete only after implementation, durable doc promotion, automated checks, mobile/desktop visual verification, and deletion of `.codex/plans/<feature-slug>.md`.
