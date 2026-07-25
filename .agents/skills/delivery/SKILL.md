---
name: delivery
description: Implement and deliver Chase Sets product, domain, documentation, infrastructure, operational workflow, or skill-maintenance changes with process proportional to blast radius. Fast path for low-risk changes (docs, copy, config, tooling, single-context work); full planning for money movement, cross-context contracts/events, external provider contracts, schema migrations, and destructive data changes. Use when implementing or delivering a change with repo evidence — including when dispatched a lane assignment by the milestone orchestrator.
---

# Delivery

Deliver changes using the repo's bounded contexts as the source of truth, with process proportional to blast radius. Default to the fast path; escalate to the full path only when a full-path trigger applies.

This skill is tracked identically at `.agents/skills/` (read by Codex) and `.claude/skills/` (read by Claude Code) so both harnesses see it; edit both copies in the same PR (guard: `scripts/check-structure/skill-mirror.test.mjs`).

## Modes

**Lane mode (default when dispatched).** Your prompt came from the milestone orchestrator with an issue and an assigned worktree. Your scope ends at a **green, ready, non-draft PR plus a completion report**. Do not enqueue, merge, verify deploys, or create/remove worktrees — the orchestrator owns landing and the pipeline.

**Solo mode.** Todd asked you directly with no orchestrator dispatch. Deliver end-to-end — but before landing, check the orchestration lease at `../.orchestrator/lease.json` (container root, sibling of your checkout). If its `renewedAt` is within the last 60 minutes, an orchestrator is live and landing belongs to it: leave the PR ready, report it, and stop. The merge queue has exactly one writer at all times.

## Change Tiers

**Fast path (default).** Docs, copy, UI tweaks, config, tooling, tests, and single-context changes with no money movement, no cross-context contract/event changes, no external provider contract changes, and no schema migration:

1. Get on a branch from fresh `origin/main` (see Worktrees).
2. Read the owning context's `README.md`/`GLOSSARY.md` if the area is unfamiliar.
3. Implement with targeted tests; run the scoped checks for touched workspaces.
4. Open a short PR (template below) and follow Readiness; landing per your mode.

No plan file, no sandbox bootstrap unless the tests touched need the database, no per-PR deployment verification.

**Full path.** Money movement (payments, settlement, payouts, tax), cross-context contract or event changes, external provider contract changes (payment-provider event sets, webhook payloads, third-party API schemas), schema migrations, destructive data changes, or work explicitly flagged as high risk. Everything in the fast path, plus Planning and a bounded self-review pass before PR readiness; in solo mode, also deploy-awareness after merge (see Deployment).

When in doubt, start on the fast path and escalate the moment scope grows into a full-path trigger.

## Worktrees

**Lane mode:** work in the worktree you were assigned; never create, switch, or remove worktrees.

**Solo mode:** maintain a small pool (2–3) of standing worktrees beside `main/`; reuse them across changes instead of creating one per change:

```powershell
git -C main fetch origin main
git -C <worktree> switch -c <branch> --track origin/main
```

- `main/` is the primary checkout and stays on `main`; never switch branches there.
- Create a new worktree only when the pool is busy, and only through the validated helper: `pnpm run ops worktree:add <name> [branch]` (hand-built `git worktree add` commands have produced corrupted `;C`-suffixed directories twice; the helper rejects malformed names before git runs).
- Install dependencies once per worktree (`pnpm run deps:install`) and reuse them; all checkouts on the drive share pnpm's per-drive content-addressed store automatically (set `CHASE_SETS_PNPM_STORE_DIR` only to relocate it).
- Remove only corrupted or excess worktrees (`git worktree remove`, then `git -C main worktree prune`).

## Planning (full path only)

- Read the owning context docs: `bounded-contexts/<context>/README.md`, `GLOSSARY.md`, `context.json`, and `docs/architecture/bounded-context-structure.md` when structure matters.
- Check the orchestrator's defect-class ledger (`~/.claude/skills/milestone-orchestrator/references/defect-classes.md`) for classes whose territory overlaps your footprint. Lane dispatches get overlapping constraints pasted into the prompt; solo sessions must read the ledger themselves — every entry is a defect that has already burned a review round or escaped to production at least once.
- Search code and tests for relevant terms, events, routes, IDs, projections, and integrations before asking anything.
- Blocking decisions split by blast radius and mode:
  - **Reversible, low-blast-radius ambiguity:** proceed on your recommended answer and flag the assumption in the PR description.
  - **Full-path trigger decisions** (money movement, cross-context contracts/events, schema, destructive data): never assume. Lane mode — stop that thread, state the decision with a recommendation and repo evidence in your completion report; the orchestrator queues it as a decision task. Solo mode — batch all such questions into one message to Todd, each with the decision, why it matters, a recommended answer, and repo evidence.
- Record decisions in the PR description under Resolved Decisions. Files under `.codex/plans/` are optional scratch artifacts — they are gitignored and must never be committed.
- Do not edit product code, runtime code, schemas, or UI while a full-path plan is still unresolved.

## Implementation & Verification

- Inner loop is watch mode (`pnpm --filter @chase-sets/<workspace> run test:watch`); run the scoped checks for every touched workspace before opening the PR. Reserve full `verify` for plausible cross-workspace impact — scope-gated CI carries the full gate.
- Rebase onto latest `origin/main` before every push, and regenerate derived artifacts as part of the rebase (localization fingerprints, design-system ledgers/`COMPONENT_INDEX`).
- Run `pnpm run verify:static` before every push.
- External provider contracts (event sets, webhook payloads, API schemas) are verified against the provider's **test-mode surface** (e.g. a Stripe test-mode create), not internal consistency — internal-only validation has passed every internal gate and still been rejected live. Include the test-mode output in Verification.
- Your verification evidence is input to external validation — you do not self-certify done. Report exactly what you ran and observed.

## Review

- One bounded self-review pass per PR before marking it ready: correctness, security of touched surfaces, simplicity, and test adequacy. Fix what you find; do not loop until perfection.
- For full-path work, produce a compact review packet from the issue's seed:
  changed invariants, likely failure modes, exact omission-revealing artifacts,
  and the focused commands/probes that exercise them. This packet directs the
  independent attack; it never asks the reviewer to trust the author's result.
- Two probes are mandatory in that pass when they apply, because both defect classes have shipped through green CI:
  - **Changed a service function's signature?** Grep every caller — including composition roots and support/wiring layers — and replace hand-written decoupled function types and `as {...}` casts with the imported interface, so future drift is a typecheck error. A unit test in a fake harness does not prove the production caller compiles.
  - **Added validation to a command handler?** Enumerate every seeding path (seed, bootstrap, import, reconciliation) and run each against the new rules. PR-lane CI does **not** run the DB-profile suite — the merge group is its first executor — so stand up a disposable Postgres locally rather than pushing unverified attempts.
- Comprehensive tech-debt review happens on a weekly repo-wide cadence, not per PR.
- Milestone reviews (anti-ratchet): at most one comprehensive review per milestone per week, and each review must close or deliver something. Never amend new requirements into existing issues — a genuinely new gap becomes a new, fixed-scope issue. This applies to issue and milestone comments too: review passes and evidence ledgers must not relocate there. The cadence is monitored by the weekly Review Cadence Digest workflow (advisory, never blocking).
- Milestone and launch evidence lives in the closing GitHub issue/PR, git history, and gitignored `artifacts/` outputs from the retained ops verifiers; do not add evidence ledgers or signoff checklists to committed docs. Evidence recorded against a main commit stays valid for its descendants unless the covered surface changed, so do not request or perform broad "current-main revalidation" passes.

## Repair Continuation

When an independent review returns `BLOCK_FIXABLE`, continue from its complete
repair brief rather than rediscovering the PR:

- Confirm the exact reviewed head, then address every stable finding ID in one
  bounded pass.
- Apply the prescribed remedy literally when safe. If the remedy requires a new
  decision, expanded footprint, or changed acceptance criterion, stop and report
  that finding as needing replanning.
- Preserve every behavior the reviewer marked verified-good.
- Report each finding ID as repaired, disputed with executed evidence, or
  escalated; never silently omit one.
- If the reviewer attached a patch, treat it as an untrusted proposal. The
  author applies/accepts it and runs the scoped proof; the reviewer never
  self-certifies its own patch.

## PR & Readiness

Keep PR bodies to roughly 10–20 lines:

```markdown
## Summary
<what changed and why, a few bullets>

## Resolved Decisions
<only decisions worth recording; link an ADR for hard-to-reverse ones; note any assumptions made in lieu of blocking questions>

## Design Evidence
<full path, only when a footprint below applies — these defect shapes are invisible in a diff, so produce the artifact that makes the omission visible:
state machine/lifecycle → every state, every transition, the steady state, and day-after routine behavior ·
validation on a shared handler → the caller inventory (seed/bootstrap/import/reconciliation) and which you ran ·
external provider contract → the provider's test-mode validation output>

## Review Packet
<full path: changed invariants, likely failure modes, omission-revealing artifacts, and focused attack commands/probes>

## Verification
<what you ran and observed>

Closes #<issue>
```

Do not include goal-completion boilerplate, worktree/sandbox metadata, or restated checklists.

**Draft semantics.** Open the PR as a draft while iterating. Mark it ready only when scoped checks are green, the self-review is done, and no full-path assumption is unresolved. If anything is unresolved, stay draft and say why in your report — draft vs. ready is a deliberate signal, and the orchestrator never readies drafts on your behalf.

## Completion Report (lane mode)

End your lane with a report the orchestrator can act on:

1. PR number and state — ready, or draft plus why.
2. Verification run and observed results.
3. File footprint touched (for parallel-lane collision checks).
4. Assumptions flagged in the PR.
5. Decisions needing escalation, each with a recommendation.
6. Full-path review packet, or repair finding IDs with one disposition each.

## Landing (solo mode only)

Check the orchestration lease first (see Modes). If clear: this repo uses the GitHub merge queue for `main`. After checks pass, enqueue the PR and wait for the queued merge to complete. If `gh pr merge` routes through auto-merge and GitHub rejects it because repository auto-merge is disabled, enqueue with the GraphQL `enqueuePullRequest` mutation.

## Deployment (solo mode only)

Per-PR staging/production verification is not required; the deploy pipeline gates releases. Check deploy health promptly after landing full-path changes that alter money movement, schemas, or deploy tooling. When an orchestrator is live, it owns deploy verification.

## Cleanup (solo mode only)

- Keep pooled worktrees for reuse; delete merged remote branches and stale local branches.
- Refresh `main/` periodically when it is clean: `git -C main fetch origin main` then `git -C main reset --hard origin/main`.

## Rules

- Resolve answerable questions from code and docs yourself.
- Use exact model versions in every routed or reported lane identity. A successor
  is a new model; predecessor evidence, vetoes, and verdicts never transfer.
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
