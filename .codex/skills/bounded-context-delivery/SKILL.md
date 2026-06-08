---
name: bounded-context-delivery
description: Deliver Chase Sets product, domain, documentation, infrastructure, operational workflow, or skill-maintenance changes through bounded-context planning, isolated worktree execution, PR/CI/GitHub merge queue/deployment verification, and final local cleanup. Use when the user asks to plan or implement a change with repo evidence, one blocking question at a time, recommended answers, checklist implementation plans captured in PR details, goal creation, and no product/runtime edits during planning.
---

# Bounded Context Delivery

Deliver changes from inside an isolated git worktree, using the repo's bounded contexts as the source of truth. Product and domain implementation require planning first. For explicit documentation, infrastructure, operational workflow, or skill-maintenance requests, finish the planning pass, record the decisions, create the goal, then make the scoped non-product edits.

## Workflow

1. Set up the worktree from fresh `origin/main` using the Worktree Setup commands.
2. Treat the new worktree as the active repository root for all reads, edits, dependency setup, verification, commits, pushes, and PR work.
3. Identify likely owning context(s), then read:
   - `bounded-contexts/README.md`
   - `bounded-contexts/<context>/README.md`
   - `bounded-contexts/<context>/GLOSSARY.md`
   - `bounded-contexts/<context>/context.json`
   - `docs/architecture/bounded-context-structure.md` when structure matters
4. Search code and tests for relevant terms, events, routes, IDs, projections, UI labels, and integrations before asking questions.
5. Create or update `.codex/plans/<yyyymmdd>-<feature-slug>.md` using the Plan File requirements.
6. Resolve decisions in dependency order: ownership, language, invariants, events, read models, APIs, UI, operations.
7. Ask exactly one blocking question at a time. Include the decision, why it matters, recommended answer, repo evidence, and consequence of choosing differently. Use `request_user_input` when available.
8. Update the plan after each answer, repo finding, contradiction, recommendation, and doc change.
9. When planning is complete, create a goal that references the worktree path, branch, plan path, implementation checklist, verification, tech debt review, durable doc promotion, PR details containing the finished plan, CI, GitHub merge queue, merge, deployment checks, generated plan deletion, local container deletion, worktree deletion, remote PR branch deletion, local branch deletion, and `main/` refresh.
10. Implement the checklist in the worktree, update checklist status as work completes, and keep edits scoped to the approved implementation.
11. Before release hardening, run a comprehensive tech debt review across the implemented scope and its touched dependencies: look for unnecessary complexity, duplicated logic, dead code, stale abstractions, weak naming, ownership leaks between contexts, brittle tests, missing test seams, migration or schema cleanup, dependency drift, slow paths, and operational footguns. Address every in-scope finding before continuing; document any deliberately deferred out-of-scope findings with rationale, owner, and follow-up path.
12. Before PR readiness, run a release hardening loop: review the complete feature, including behavior outside the diffs and upstream/downstream impacts, for user value, correctness, simplicity, maintainability, reliability, security, performance, and cost; fix every P0-P2 finding; rerun targeted verification; repeat until no P0-P2 findings remain. Document any remaining P3+ items as accepted follow-up with rationale.
13. Open a ready PR with the finished plan in the PR body/details, wait for required review and checks, enqueue the PR in the GitHub merge queue, wait for the queue to merge it, verify staging and production deployments, then complete Cleanup.

## Worktree Setup

Use a sibling worktree inside the shared project folder so the chat can run commands inside the accessible repo workspace. The main checkout lives at `main/`; create feature worktrees beside it:

```powershell
git -C main fetch origin main
git -C main worktree add ../<yyyymmdd>-<feature-slug> -b codex/<feature-slug> origin/main
```

- Treat the project folder as the checkout container: `main/` is the primary checkout with the common Git directory at `main/.git`, and each dated sibling worktree has its own `.git` indirection file.
- Always branch from freshly fetched `origin/main`; do not branch from the current worktree `HEAD`.
- If `origin/main` cannot be fetched or verified as current, pause and report the worktree setup blocker instead of creating a branch from stale local state.
- Do not run `git switch`, `git checkout`, `git pull`, or other branch-changing commands in the `main/` checkout to prepare for planning; the `git worktree add ... -b ... origin/main` command creates and checks out the branch inside the new worktree.
- After worktree creation, treat the new worktree path as the active repository root. Run every later command with the worktree as `cwd` or `workdir`, including reads, edits, dependency setup, tests, commits, pushes, and PR work.
- Reuse an existing branch or path only when it clearly belongs to this request.
- Do not recreate `.codex/worktrees/`; generated worktrees belong beside `main/` in the project folder and remain outside the tracked checkout.
- Install dependencies in the worktree before build, test, or dev commands: `pnpm run deps:install` or `node ./scripts/worktree-deps.mjs install`.
- The default shared pnpm store for `main/` and sibling worktrees is `../.chase-sets-pnpm-store` from each checkout; set `CHASE_SETS_PNPM_STORE_DIR` only if the default fails.
- Run `pnpm run sandbox:doctor` after dependency setup. Use `docs/runbooks/local-worktree-sandboxes.md` for sandbox troubleshooting.

## Plan File

Create the plan at `.codex/plans/<yyyymmdd>-<feature-slug>.md` using the local current date. Use this template and keep the implementation plan as a checklist:

```markdown
# <Feature>

## Intent
## Worktree
## Owning Contexts
## Resolved Decisions
## Open Questions
## Implementation Checklist
- [ ] <verifiable implementation, documentation, or verification step>
## Documentation To Promote
## Goal Completion Criteria
```

- `Worktree` must list path, branch, sandbox id, dependency setup status, pnpm store path, and setup blockers.
- `Implementation Checklist` must contain concrete checkbox items using `- [ ]` and must be updated to `- [x]` as each item is completed.
- Checklist items must be verifiable and include implementation, docs, and test/verification work when they apply.
- Treat the plan as a generated working artifact: do not commit it, and do not promote it as durable documentation.
- Before submitting the PR, copy the finished plan into the PR body/details so decisions and completion criteria are preserved in PR history. Durable docs created from the plan remain repository artifacts and must be committed normally.

The `Goal Completion Criteria` section must always include:

- PR submitted for the completed implementation or scoped non-product change, with the finished plan included in the PR body/details.
- Implementation Checklist completed.
- Comprehensive tech debt review completed before release hardening; every in-scope finding addressed, with any deferred out-of-scope findings documented with rationale, owner, and follow-up path.
- Release hardening loop completed with no unresolved P0-P2 findings; any remaining P3+ items documented as accepted follow-up with rationale.
- CI passing on the PR before merge queue entry.
- PR entered into the GitHub merge queue after required review and passing checks.
- PR merged through the GitHub merge queue.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Generated plan file deleted after its final contents are captured in the PR details.
- Worktree deleted after the generated plan file is deleted and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
- `main/` fetched and reset to the latest `origin/main` after local cleanup.

Do not mark the goal complete until all criteria are satisfied or the user explicitly redefines the goal.

## GitHub Merge Queue

This repo uses GitHub merge queue for `main`. After the PR has required review and passing checks, enqueue it and wait for the queued merge to complete. If `gh pr merge` routes through auto-merge and GitHub rejects it because repository auto-merge is disabled, enqueue with the GraphQL `enqueuePullRequest` mutation.

## Cleanup

After the PR is merged through the queue:

- Stop current worktree services.
- Delete the current worktree's local container or sandbox with scoped cleanup, such as `pnpm run dev:down` or `pnpm run sandbox:clean`; never run `sandbox:clean:all`.
- Delete the generated `.codex/plans/<yyyymmdd>-<feature-slug>.md` plan after its final contents are captured in the PR details.
- Remove the worktree.
- Delete the remote PR branch when one exists.
- Delete the local branch after the worktree is removed.
- Refresh `main/`:

```powershell
git -C main fetch origin main
git -C main reset --hard origin/main
```

## Rules

- Do not edit product code, runtime code, schemas, tests, or UI during planning.
- For explicit documentation, infrastructure, operational workflow, or skill-maintenance requests, keep implementation edits scoped to those surfaces unless the user separately approves product/runtime changes.
- Resolve answerable questions from code and docs yourself.
- Call out glossary conflicts and propose one canonical term plus owning context.
- Tie each cross-context interaction to one behavior owner and one stable published fact.
- Stress-test decisions for normal flow, partial flow, stale data or replay, cross-context handoff, failure/cancellation, and low-value card economics when relevant.
- Surface contradictions between docs, code, and the plan before continuing.

## Where To Put Durable Docs

- Local term: `bounded-contexts/<context>/GLOSSARY.md`
- Cross-context term index: `docs/GLOSSARY.md`
- Context note: `bounded-contexts/<context>/docs/<topic>.md`
- System decision: `docs/adr/<next-number>-<slug>.md`
- Architecture: `docs/architecture/<topic>.md`
- API docs: `docs/api/`
- Runbooks: `docs/runbooks/`
- Design-system patterns: `packages/design-system/`

Update `docs/README.md` when adding durable docs that should appear in the curated docs map. Use ADRs only for hard-to-reverse or surprising decisions with real trade-offs.

## Pause Report

Before pausing, report the worktree path, branch, sandbox status, plan path, resolved decisions, docs updated, contradictions found, and next unresolved question.
