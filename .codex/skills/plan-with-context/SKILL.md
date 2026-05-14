---
name: plan-with-context
description: Plan implementation or product features against the Chase Sets bounded-context model, ubiquitous language, code, and docs. Use when the user asks to plan or implement a feature with one-question-at-a-time prompts, recommended answers, code/doc cross-checks, plan/doc creation, goal creation, and no product code changes during planning.
---

# Plan With Context

Plan a feature against the repo's domain model inside an isolated feature worktree. In this skill, "implement" means create the worktree, collect decisions, write planning artifacts/docs, and create a goal for implementation; do not change product code.

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

1. Create or switch into a dedicated feature worktree before reading deeply or writing the plan.
2. Identify likely owning context(s) from inside that worktree.
3. Read the repo map files plus each candidate context's `README.md`, `GLOSSARY.md`, and `context.json`.
4. Search code for relevant terms, events, routes, IDs, projections, UI labels, and tests before asking answerable questions.
5. Create or update `.codex/plans/<yyyymmdd>-<feature-slug>.md`, using the local current date for sortable ordering, for example `20260513-my-new-feature.md`.
6. Ask the next blocking question with the decision, why it matters, recommended answer, repo evidence, and consequence of choosing differently. Use interactive `request_user_input` prompts when available; otherwise ask in plain text.
7. After each answer or finding, update the plan and any already-settled docs.
8. When planning is complete, create a `/goal` whose objective references the worktree path, branch, plan path, and owns implementation, durable doc promotion, verification, visual checks, PR submission, passing CI, PR merge, preview deploy verification and cleanup, production deploy verification when the merge reaches `main`, and plan retention.

Walk questions in dependency order: ownership, language, invariants, events, read models, APIs, UI, operations.

## Worktree Setup

Create the worktree first so planning, implementation, builds, tests, app servers, generated env, and Docker resources stay isolated from other work.

1. Derive a short feature slug from the request, then choose a sibling worktree path such as `../chase-sets-<yyyymmdd>-<feature-slug>` and a branch such as `codex/<feature-slug>`.
2. Branch from the current repo HEAD unless the user names a base; if the branch or path exists, inspect it and reuse it only when it clearly belongs to this request.
3. If already in a dedicated feature worktree for this exact request, use it and record that decision. Otherwise run `git worktree add <path> -b <branch>` from the source repo.
4. Continue all later reads, edits, plan updates, docs, dependency setup, and verification commands from the new worktree path.
5. Run `pnpm run deps:install` or `node ./scripts/worktree-deps.mjs install` in the worktree before any build/test/dev command that needs dependencies.
6. Run `pnpm run sandbox:doctor` in the worktree after dependency setup. Use `docs/runbooks/local-worktree-sandboxes.md` when troubleshooting ports, Docker Compose projects, generated `.env.sandbox.local`, or DB-backed tests.
7. Record the worktree path, branch, sandbox id, and any setup caveats in the plan before asking the first blocking product/domain question.

Never use `sandbox:clean:all` as part of this skill. Use only current-worktree cleanup commands, such as `pnpm run dev:down` or `pnpm run sandbox:clean`, and only when cleanup is explicitly needed.

## Working Plan

Use `.codex/plans/<yyyymmdd>-<feature-slug>.md` as durable memory for compaction, handoff, review, and optional `/goal` tracking. Keep it in dependency order and include only sections that are useful:

```markdown
# <Feature>

## Intent
## Worktree
## Owning Contexts
## Resolved Decisions
## Open Questions
## Implementation Checklist
## Documentation To Promote
## Goal Completion Criteria
```

Update the plan after every worktree setup finding, answered question, repo finding, accepted/rejected recommendation, and doc change. `Worktree` must list the path, branch, sandbox id, dependency setup status, and current setup blockers if any. `Goal Completion Criteria` must list what the later implementation goal must verify, promote, retain, submit, merge, and confirm in deployed preview or production environments as appropriate for the change.
Do not delete the plan as part of cleanup; cleanup is limited to temporary artifacts. Keep the plan committed with the implementation so reviewers can inspect the planning decisions later.

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

Before pausing, report the worktree path, branch, sandbox status, plan path, resolved decisions, docs updated, contradictions found, and next unresolved question.

This skill is complete when the feature worktree exists, the plan/docs are written in that worktree, and the implementation goal exists. The goal is complete only after implementation in the feature worktree, durable doc promotion, automated checks, mobile/desktop visual verification when relevant, PR submission, passing CI, PR merge, successful preview deploy verification and cleanup, successful production deploy verification when the merge reaches `main`, and committing the retained `.codex/plans/<yyyymmdd>-<feature-slug>.md`.
