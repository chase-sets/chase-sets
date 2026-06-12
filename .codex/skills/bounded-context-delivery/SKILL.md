---
name: bounded-context-delivery
description: Deliver Chase Sets product, domain, documentation, infrastructure, operational workflow, or skill-maintenance changes with process proportional to blast radius. Fast path for low-risk changes (docs, copy, config, tooling, single-context work); full planning for money movement, cross-context contracts/events, schema migrations, and destructive data changes. Use when the user asks to plan or implement a change with repo evidence.
---

# Bounded Context Delivery

Deliver changes using the repo's bounded contexts as the source of truth, with process proportional to blast radius. Default to the fast path; escalate to the full path only when a full-path trigger applies.

## Change Tiers

**Fast path (default).** Docs, copy, UI tweaks, config, tooling, tests, and single-context changes with no money movement, no cross-context contract/event changes, and no schema migration:

1. Branch from fresh `origin/main` in a pooled worktree (see Worktrees).
2. Read the owning context's `README.md`/`GLOSSARY.md` if the area is unfamiliar.
3. Implement with targeted tests; run the scoped checks for touched workspaces.
4. Open a short PR (template below) and merge on green through the merge queue.

No plan file, no sandbox bootstrap unless the tests touched need the database, no per-PR deployment verification.

**Full path.** Money movement (payments, settlement, payouts, tax), cross-context contract or event changes, schema migrations, destructive data changes, or work the user explicitly flags as high risk. Everything in the fast path, plus Planning and a bounded self-review pass before PR readiness, and deploy-awareness after merge (see Deployment).

When in doubt, start on the fast path and escalate the moment scope grows into a full-path trigger.

## Worktrees

Maintain a small pool (2–3) of standing worktrees beside `main/`; reuse them across changes instead of creating one per change:

```powershell
git -C main fetch origin main
git -C <worktree> switch -c <branch> --track origin/main
```

- `main/` is the primary checkout and stays on `main`; never switch branches there.
- Create a new worktree only when the pool is busy: `git -C main worktree add ../<name> -b <branch> origin/main`.
- Install dependencies once per worktree (`pnpm run deps:install`) and reuse them; the shared pnpm store is `../.chase-sets-pnpm-store`.
- Remove only corrupted or excess worktrees (`git worktree remove`, then `git -C main worktree prune`).

## Planning (full path only)

- Read the owning context docs: `bounded-contexts/<context>/README.md`, `GLOSSARY.md`, `context.json`, and `docs/architecture/bounded-context-structure.md` when structure matters.
- Search code and tests for relevant terms, events, routes, IDs, projections, and integrations before asking anything.
- Batch all blocking questions into one message, each with the decision, why it matters, a recommended answer, and repo evidence. If the user is unavailable, proceed on the recommended answers and flag each assumption in the PR description.
- Record decisions in the PR description under Resolved Decisions. Files under `.codex/plans/` are optional scratch artifacts — they are gitignored and must never be committed.
- Do not edit product code, runtime code, schemas, or UI while a full-path plan is still unresolved.

## Review

- One bounded self-review pass per PR before marking it ready: correctness, security of touched surfaces, simplicity, and test adequacy. Fix what you find; do not loop until perfection.
- Comprehensive tech-debt review happens on a weekly repo-wide cadence, not per PR.
- Milestone reviews (anti-ratchet): at most one comprehensive review per milestone per week, and each review must close or deliver something. Never amend new requirements into existing issues — a genuinely new gap becomes a new, fixed-scope issue. This applies to issue and milestone comments too: review passes and evidence ledgers must not relocate there. The cadence is monitored by the weekly Review Cadence Digest workflow (advisory, never blocking).
- Launch proof is monotonic (see `docs/launch/checklist.md`): evidence recorded against a main commit stays valid for its descendants unless the covered surface changed. Do not request or perform "current-main revalidation" passes, and record evidence rows only in the checklist via PR.

## PR Template

Keep PR bodies to roughly 10–20 lines:

```markdown
## Summary
<what changed and why, a few bullets>

## Resolved Decisions
<only decisions worth recording; link an ADR for hard-to-reverse ones; note any assumptions made in lieu of blocking questions>

## Verification
<what you ran and observed>

Closes #<issue>
```

Do not include goal-completion boilerplate, worktree/sandbox metadata, or restated checklists.

## Merge Queue

This repo uses the GitHub merge queue for `main`. After checks pass, enqueue the PR and wait for the queued merge to complete. If `gh pr merge` routes through auto-merge and GitHub rejects it because repository auto-merge is disabled, enqueue with the GraphQL `enqueuePullRequest` mutation.

## Deployment

Per-PR staging/production verification is not required; the deploy pipeline gates releases. Check deploy health on a cadence (at least daily), and promptly after merging full-path changes that alter money movement, schemas, or deploy tooling.

## Cleanup

- Keep pooled worktrees for reuse; delete merged remote branches and stale local branches.
- Refresh `main/` periodically when it is clean: `git -C main fetch origin main` then `git -C main reset --hard origin/main`.

## Rules

- Resolve answerable questions from code and docs yourself.
- Call out glossary conflicts and propose one canonical term plus owning context.
- Tie each cross-context interaction to one behavior owner and one stable published fact.
- Surface contradictions between docs, code, and the change before continuing.

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
