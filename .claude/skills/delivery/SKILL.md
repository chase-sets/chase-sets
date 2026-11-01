---
name: delivery
description: Implement and deliver Chase Sets product, domain, documentation, infrastructure, operational workflow, or skill-maintenance changes with process proportional to blast radius. Fast path for low-risk changes (docs, copy, config, tooling, single-context work); full planning for money movement, cross-context contracts/events, external provider contracts, schema migrations, and destructive data changes. Use when implementing or delivering a change with repo evidence — including when dispatched a lane assignment by the milestone orchestrator.
---

# Delivery

Deliver changes using the repo's bounded contexts as the source of truth, with process proportional to blast radius. Default to the fast path; escalate to the full path only when a full-path trigger applies.

This skill is tracked identically at `.agents/skills/` (read by Codex) and `.claude/skills/` (read by Claude Code) so both harnesses see it; edit both copies in the same PR (guard: `scripts/check-structure/skill-mirror.test.mjs`).

## Modes

**Lane mode (default when dispatched).** Your prompt came from the milestone orchestrator with an issue and an assigned worktree. Your scope ends at a **pushed draft PR plus a completion report**, with scoped checks green and the Quality Packet complete (see **Draft semantics**). The host dispatches independent exact-head review; do not launch reviewers, mark ready, enqueue, merge, verify deploys, or create/remove worktrees — the orchestrator owns review dispatch, landing and the pipeline.

**Solo mode.** Todd asked you directly with no orchestrator dispatch. Deliver end-to-end — but before landing, check the orchestration lease at `../.orchestrator/lease.json` (container root, sibling of your checkout). If its `renewedAt` is within the last 60 minutes, an orchestrator is live and landing belongs to it: leave the PR ready, report it, and stop. The merge queue has exactly one writer at all times.

### Premise check (before the first edit)

Before implementation guidance, run the premise check before the first edit using reads and the brief's own inspection steps only. In lane mode:

- The issue must be open and carry neither `status:needs-replan` nor `status:tracking-only`; no comment after the brief's last edit may supersede it; the outcome must not already be present at the baseline; and a defect must still be present at the baseline when it can be shown.
- Product work uses fresh `origin/main`; controller work under the container `.orchestrator/` uses the installed reviewed controller head from `~/.claude/skills/native-db/identity.json`, validated as `controller-release-battery.ps1:646-648` does: the identity has exactly two properties, a lowercase 40-hex `head` and a lowercase 64-hex `digest`. A missing or invalid identity makes the baseline unavailable (handled as unavailable, never a negative premise); and a path the brief plans to create does not exist yet, so its absence is never a premise failure.
- Any result except `CONFIRMED` ends the lane before an edit, push or PR, with the evidence in the report; the lane never closes or relabels the issue.
- Unavailable is not negative: `NOT_REPRODUCED` requires a reproduction that actually ran and did not show the defect, `ALREADY_DELIVERED` requires a named commit or PR at an available baseline, and a local harness, environment or lock failure or unavailable baseline yields `CONFIRMED (unverified: <reason>)` and proceeds under the existing hosted-substitution rule. Inspection of code or retained hosted evidence may confirm the premise instead.

In solo mode, run the same check and disposition its result: `ALREADY_DELIVERED` closes the issue citing the commit or PR; `SUPERSEDED_BY` applies the planning supersession rule including its product-question exception; and `NOT_REPRODUCED` or `PREMISE_CHANGED` comments with evidence and then amends the brief, closes it only when no accepted product scope is dropped, or asks Todd one product question.

## Change Tiers

**Fast path (default).** Docs, copy, UI tweaks, config, tooling, tests, and single-context changes with no money movement, no cross-context contract/event changes, no external provider contract changes, and no schema migration:

1. Get on a branch from fresh `origin/main` (see Worktrees).
2. Read the owning context's `README.md`/`GLOSSARY.md` if the area is unfamiliar.
3. Implement with targeted tests; run the scoped checks for touched workspaces.
4. Open a short PR (template below) and follow Readiness; landing per your mode.

No plan file, no sandbox bootstrap unless the tests touched need the database, no per-PR deployment verification.

**Full path.** Money movement (payments, settlement, payouts, tax), cross-context contract or event changes, external provider contract changes (payment-provider event sets, webhook payloads, third-party API schemas), schema migrations, destructive data changes, or work explicitly flagged as high risk. Everything in the fast path, plus Planning and the full-path Design Evidence described below; in solo mode, also deploy-awareness after merge (see Deployment).

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
- Query the orchestrator ledgers for the issue text and predicted footprint:

  ```powershell
  pwsh -NoProfile -File ~/.claude/skills/milestone-orchestrator/scripts/query-ledgers.ps1 -Mode implementation -Text "<issue and domain terms>" -Footprint "<predicted paths>"
  ```

  Lane dispatches carry these results in the prompt; solo sessions run the query
  themselves. Apply only the returned constraints. Never load the full ledgers
  during normal delivery; search a named entry only when the query points to it
  or when auditing retrieval coverage.
- Search code and tests for relevant terms, events, routes, IDs, projections, and integrations before asking anything.
- Blocking decisions split by blast radius and mode:
  - **Reversible, low-blast-radius ambiguity:** proceed on your recommended answer and flag the assumption in the PR description.
  - **Full-path trigger decisions** (money movement, cross-context contracts/events, schema, destructive data): never assume. Lane mode — stop that thread, state the decision with a recommendation and repo evidence in your completion report; the orchestrator is the host and routes it. Solo mode — you are the host: record each decision with why it matters, a recommended answer, and repo evidence, and route it under Decision routing. Never batch these decisions to Todd.
  - **Decision routing**: the host decides same-attempt, in-scope repairs itself — stale test pins or counts, fixture collisions, sink or path mistakes, prompt defects, continuation authority, agent-owned placement — and records each as `decision-resolved` with its reasoning. An independent decision lane is required only when the decision changes accepted scope or acceptance criteria, ownership or authority, or crosses lineages; its verdict is final, and the host records it and proceeds. A decision lane may not return `TODD_RULING_NEEDED`: if it believes Todd must decide, that is a finding the host resolves with a second independent lane. Independent code/planning review and review-contract/v2 are unchanged.
  - **Todd receives only two kinds of question**: product priority or scope changes, and operator actions no lane can perform. Package an operator action as one concrete, runnable step. Never escalate another review pass, revision, replan, step-back verdict or proof route to Todd; the host routes those decisions.
- Record decisions in the PR description under Resolved Decisions. Files under `.codex/plans/` are optional scratch artifacts — they are gitignored and must never be committed.
- Do not edit product code, runtime code, schemas, or UI while a full-path plan is still unresolved.

## Operator boundary

Chase Sets never contacts TCGplayer servers and never stores or uses TCGplayer auth cookies or credentials.

Agents prepare, execute, monitor, capture evidence, clean up, and report probes
and routine work. This boundary applies on both delivery paths; "operator
actions no lane can perform" means only the residual human step, not a runbook
for Todd. Todd retains product priority/scope and unrelated reserved authority.

- Use admitted tools, including supported computer use for approved-scope OAuth,
  sandbox/test sign-ins, and credential entry when permitted. Missing tooling is
  agent-owned repair, not a reason to assign Todd the workflow. Actual tool
  policy still governs; do not bypass a restriction or automate TCGplayer login.
- Request only production-credential or real-money authorization/supervision,
  private entry for credentials agents may not hold, protected Windows permission
  prompts, or an actual policy/external-authority step agents cannot lawfully
  perform. Name the environment, reason a human is needed, exact residual step,
  and agent resumption point; agents own preparation and all permitted work around
  it. A test using a live credential or real charge is not autonomous sandbox work.
- Preserve privacy, least privilege, secret safety, and
  production credential custody,
  never expose secrets in chat,
  logs, screenshots, evidence, or commits. Human private entry is only for
  credentials agents may not hold; sandbox/test safe-entry gaps are agent repair.
  Preserve provider restrictions, external approvals at their ruled lifecycle,
  scope limits, and stop conditions. A GA-only approval does not become a
  sandbox/pre-GA hold. This guidance grants no provider or production
  authorization. No broader access, outreach, impersonation, retry, evidence or
  lifecycle authority is granted.
- If acceptance explicitly names a human performer or human-only evidence,
  obtain prospective acceptance repair through the existing decision route and
  independent validation of the agent proof route before execution. Do not
  relabel agent evidence as human evidence or silently change an issue's ACs.
  Independent host/reviewer acceptance of a Probe is not mandatory Todd
  acceptance; the Probe's exact authority and lifecycle evidence still govern.

## Implementation & Verification

- Inner loop is watch mode (`pnpm --filter @chase-sets/<workspace> run test:watch`); run the scoped checks for every touched workspace before opening the PR. On concurrent-lane hosts, set `CHASE_SETS_LANE_MODE=1` for local Vitest commands so the shared config uses lane-safe timeouts and capped workers; leave it unset for the strict default and hosted CI profile.
- Rebase onto latest `origin/main` before every push, and regenerate derived artifacts as part of the rebase (localization fingerprints, design-system ledgers/`COMPONENT_INDEX`).
- For every nonempty diff, the ordinary pre-PR gate is a dry-run plan: `pnpm run verify:ci-local -- --mode=pull-request --provenance=same-repository --dry-run`. Use `pnpm run verify:ci-local -- --mode=pull-request --provenance=fork --dry-run` for a fork candidate. Use `pnpm run verify:ci-local -- --mode=merge-group --dry-run` only when the delivery contract explicitly requires a local preview of merge-group selection; the real hosted merge group remains authoritative. Retain the exact-head plan as PLAN_ONLY before push.
- PLAN_ONLY records a plan, not an executed local or hosted PASS. Do not execute the selected broad local battery just to publish a draft.
- The ordinary lane pre-push set is changed-file Prettier, `pnpm run format:check -- --changed`, named non-DB focused tests, and `scripts/check-structure/issue-reference-comments.test.mjs` when non-test source changed. `pnpm run typecheck:changed` is a host-attributed diagnostic only: it runs only after host-wide heavy admission; a refusal exits 73 before reservation and is `NOT_EXECUTED`, while hosted exact-head `Typecheck` is authoritative. Lanes do not retry or escalate this locally. Prettier is `--write` on committed changed files.
- Lanes run no `verify:*` gate (including `verify:static:scoped`), local DB test, workspace-wide or full battery, or other unadmitted heavy command; hosted CI owns full Static, Typecheck, Unit and DB Profile proof.
- For database-touching changes, the normal final-head hosted `DB Profile Tests` job is the DB proof. Hosted gates, timeouts, skips and reviews are unchanged.
- Hosted CI is the proof for every product attempt, not only DB. The hosted jobs on the pushed head decide it, including E2E, DB Profile, unit, static and build. Local E2E, local `verify:test-db` and other local full or harness runs are diagnostics only and never a prerequisite for push, draft, ready or landing. A local-harness, environment or lock failure never parks, fails or classifies your candidate: push it to the draft PR and let hosted CI judge it. When a brief names a local run as a gate or a stop condition, take the hosted substitution and disclose it in the PR body.
- An implementation attempt counts only when a pushed head receives a hosted CI verdict or an exact-head review verdict. Attempt counts are telemetry and step-back triggers, never a stop; no attempt count parks your issue. Local-only failures, preparation stops, harness or environment failures, lock refusals and defects in your own tooling (helper scripts, probes, config) do not count. Fix them and continue within the same attempt instead of stopping.
- External provider contracts (event sets, webhook payloads, API schemas) are verified against the provider's **test-mode surface** (e.g. a Stripe test-mode create), not internal consistency — internal-only validation has passed every internal gate and still been rejected live. Include the test-mode output in Verification.
- Your verification evidence is input to external validation — you do not self-certify done. Report exactly what you ran and observed.

### Goal-based browser probes

For a new or changed user-facing flow, use `pnpm run ops browser:usability select --base origin/main` to identify advisory goals, then follow `docs/contributing/browser-usability.md`. Dispatch a fresh goal-only participant on the model and effort `docs/contributing/browser-usability.md` names without implementation context; use screenshot-grounded navigation, the code-owned timer/action recorder, an isolated preflighted fixture, and a separate moderator outcome check. Do not use the participant's completion label as a pass. Report the adjudicated result and timing in Verification, or explicitly record not-run coverage and why. Unmapped flows need a relevant goal or an explicit coverage note. Hosted gates and independent code review remain authoritative; an unavailable local browser/sandbox is not a publication or readiness gate. Reproduced defects follow existing severity rules and get deterministic regression coverage.

## Review

- Before the implementation head is dispatched for independent review, complete one bounded author review and its `## Quality Packet` in four steps:
  1. Answer G0 first: list what was not built and give one reason for each omission.
  2. Inspect SCOPE, ROBUSTNESS, DEPTH, READABILITY, TESTS, OBSERVABILITY, SECURITY, PERFORMANCE, ROLLOUT, CONSISTENCY, EXPERIENCE, and LANGUAGE in that order. Fill both sides with `PASS` or `NOTE`, or use whole-pair `N/A` only when the diff has no surface on that pair. Make a concrete edit or record why no edit is needed for every key.
  3. For every changed rule, contract, or prose claim, check an enforcement pair: the changed item and the test, checker, or direct inspection that constrains it.
  4. Re-run the scoped check after each fix; stop a key only when a full pass makes no edit. `Edits per key:` records each edited key, its edit, and the check re-run after it.
  This author loop supplies evidence for an independent review; it never replaces that review or hosted CI ownership.
- For full-path work, add compact attack evidence from the issue's seed:
  changed invariants, likely failure modes, exact omission-revealing artifacts,
  and the focused commands/probes that exercise them. This evidence directs the
  independent attack; it never asks the reviewer to trust the author's result.
- Every PR on every path must carry one `## Quality Packet`. Its exact order is the heading; `G0: PASS — <not built, one reason each>`; `QUALITY_PROFILE: <prototype|product-feature|core-library|hot-path|migration|contract>`; `QUALITY_VERDICT:`; the twelve key lines above; then `Edits per key:`, `Enforcement pairs checked:`, and `Unverifiable assumptions:`. A key is `KEY [High|Med|Low]: little=<PASS|NOTE> <payload> ; much=<PASS|NOTE> <payload>`, or `KEY [weight]: N/A <absent surface>` when the pair has no surface in the diff. `BLOCK` belongs only to the reviewer.
- Each payload follows the matching quality-v2 Evidence column. `PASS` names the probe or artifact examined; `NOTE` names the author's non-blocking observation and its surface; whole-pair `N/A` names the absent surface. When evidence is too large to state inline, cite a resolvable repository path, `file::test name`, executed command, or PR section such as `## Design Evidence`; never use a bare verdict or unnamed "see tests". The independent reviewer must verify every Quality Packet claim and never adopt one.
- Two probes are mandatory in that pass when they apply, because both defect classes have shipped through green CI:
  - **Changed a service function's signature?** Grep every caller — including composition roots and support/wiring layers — and replace hand-written decoupled function types and `as {...}` casts with the imported interface, so future drift is a typecheck error. A unit test in a fake harness does not prove the production caller compiles.
  - **Added validation to a command handler?** Enumerate every seeding path (seed, bootstrap, import, reconciliation) and run each against the new rules. PR-lane CI runs the `DB Profile Tests` job on every PR whose change scope requires it (an affected workspace with DB-profile tests), and that hosted job is the DB proof; confirm it ran rather than skipped at your head.
- Comprehensive tech-debt review happens on a weekly repo-wide cadence, not per PR.
- Milestone reviews (anti-ratchet): at most one comprehensive review per milestone per week, and each review must close or deliver something. Agents own routine outcome placement, promotion and priority under `docs/contributing/backlog-model.md`; Todd steering is an override, never a required placement approval. Preserve accepted scope and active recovery when reorganizing work. Never amend new requirements into existing issues — a genuinely new gap becomes a new, fixed-scope issue. File it with the `slice` form so it lands classified (`refined ≡ classified`: open, non-Epic, executable wave milestone + `priority:*` + `area:*` + `kind:*`, excluding `status:tracking-only`), attach it as a **sub-issue of the owning epic** when one owns its acceptance, and record any chain link as a **GitHub issue dependency** rather than only a `Blocked by #N` line. An unclassified issue is undispatchable. Parent attachment is reported, not gating; a future parent-or-standalone gate and any `status:standalone` label require a new fixed-scope change. See `docs/contributing/backlog-model.md`. The delivery board's Status is derived by `scripts/project-status-sync.mjs`, never hand-written: a native **Epic** projects to `Epic` and a non-Epic carrying `status:tracking-only` projects to `Tracking`, both non-executable, and a hand-set value is overwritten by the next sync. This applies to issue and milestone comments too: review passes and evidence ledgers must not relocate there. The cadence is monitored by the weekly Review Cadence Digest workflow (advisory, never blocking).
- Milestone and launch evidence lives in the closing GitHub issue/PR, git history, and gitignored `artifacts/` outputs from the retained ops verifiers; do not add evidence ledgers or signoff checklists to committed docs. Evidence recorded against a main commit stays valid for its descendants unless the covered surface changed, so do not request or perform broad "current-main revalidation" passes.

## Repair Continuation

When an independent review returns `BLOCK_FIXABLE`, continue from its complete
repair brief rather than rediscovering the PR:

- Confirm the exact reviewed head, then address every stable finding ID in one
  bounded pass.
- Apply the prescribed remedy literally when safe. If the remedy requires a new
  decision, expanded footprint, or changed acceptance criterion, or asserts an
  external fact contradicted by the lane's executed probe, stop and report that
  finding as needing replanning, citing the exact measured contradiction. For a
  fact owned by an external authority, neither a reviewer nor a repair lane may
  prescribe, synthesize, or accept a coarser run/workflow-level fact as proof of
  a finer fact: evidence from the exact owning job, at the granularity the
  implementation reads, remains canonical, and its identity, executed-step
  evidence, conclusion, timestamps, and bounded pagination must reconcile.
  A missing, skipped, duplicate, malformed, or red authority candidate is
  explicit non-authority or bounded unknown; it never inherits success from an
  enclosing run/workflow. Never alter externally owned facts in a fixture paired
  with a real
  external identity to satisfy the assertion. A genuinely synthetic control
  must use unmistakably synthetic identities and be labeled synthetic.
- Preserve every behavior the reviewer marked verified-good.
- Report each finding ID as repaired, disputed with executed evidence, or
  escalated; never silently omit one.
- If the reviewer attached a patch, treat it as an untrusted proposal. The
  author applies/accepts it and runs the scoped proof; the reviewer never
  self-certifies its own patch.

## PR & Readiness

Keep PR bodies compact. The validated snippet below is the canonical section shape; replace its concrete claims with evidence from the exact head:

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

## Quality Packet
Use the validated `### Quality Packet snippet` below, replacing its concrete evidence with evidence from this exact head.

## Verification
<what you ran and observed>

Refs #<issue>
```

Do not include goal-completion boilerplate, worktree/sandbox metadata, or restated checklists. The Quality Packet is required even when `## Design Evidence` does not apply.

### Quality Packet snippet

Use this concrete, validated example as the PR's stable author record; replace its claims with evidence from the exact change. The section must stay at or below 2,048 UTF-8 bytes.

```markdown
## Quality Packet
G0: PASS — smallest shape: rename the shipped #7716 pair in place; not built: a second checker module (one file already owns the shape), a CI or launcher guard (#7737 owns it), a profile-weight table (the reviewer verifies weights).
QUALITY_PROFILE: contract
QUALITY_VERDICT:
SCOPE [High]: little=PASS AC1-AC4 → quality-packet-section-contract.test.mjs matrix ; much=PASS diff is the brief's four paths
ROBUSTNESS [High]: little=PASS every reject path returns a named error, none throws ; much=PASS no guard beyond those errors
DEPTH [High]: little=PASS script-local; 3 exports, 1 caller ; much=PASS a rename, no new abstraction
READABILITY [Med]: little=PASS trace SKILL.md → extractQualityPacketSection → errors, 2 files ; much=PASS no restating comment
TESTS [High]: little=PASS both exports and both mirrors pinned ; much=PASS asserts returned error strings, not internals
OBSERVABILITY [High]: little=PASS each rejection names its key and reason ; much=PASS accept path is silent
SECURITY [High]: N/A no input, authorization, secret, or personal-data boundary in the diff
PERFORMANCE [Low]: N/A no query or per-item I/O; bounded linear scan and two test-only mirror reads
ROLLOUT [High]: little=PASS retired headings deleted, not left beside ; much=PASS no legacy branch or flag kept
CONSISTENCY [High]: little=PASS follows scripts/check-structure conventions ; much=PASS no unstated departure
EXPERIENCE [Low]: N/A no UI surface in the diff
LANGUAGE [High]: little=PASS Quality Packet, G0, the twelve keys → contracts/quality-v2.md ; much=PASS no coined term
Edits per key: ROLLOUT deleted the retired field list; LANGUAGE renamed the completion-report item; others no edit, scoped check re-run after each.
Enforcement pairs checked: packet shape → quality-packet-section-contract.test.mjs; mirror rule → skill-mirror.test.mjs.
Unverifiable assumptions: none.
```

**Draft semantics.** Open the PR as a draft once scoped checks and affected focused checks are green and the Quality Packet is complete; disclose the exact-head PLAN_ONLY evidence. A harness or lock refusal of a scoped check is disclosed, not a draft blocker. Before ready or enqueue, all selected REQUIRED hosted gates must pass and independent exact-head implementation review must pass, with no unresolved full-path assumption. Missing, red, or skipped REQUIRED hosted gates block readiness; PLAN_ONLY never substitutes for them. If anything is unresolved, stay draft and say why in your report — draft vs. ready is a deliberate signal; in lane mode, leave the PR draft and do not mark it ready yourself. The draft may become ready only after a host-dispatched exact-head independent PASS with every selected REQUIRED hosted gate green, never over a blocker the lane reported.

## Completion Report (lane mode)

End your lane with a report the orchestrator can act on:

0. `PREMISE:` — exactly one of `PREMISE: CONFIRMED <one line>`, `PREMISE: ALREADY_DELIVERED <commit or PR>`, `PREMISE: SUPERSEDED_BY #<n>`, `PREMISE: NOT_REPRODUCED <command and observed output>`, or `PREMISE: PREMISE_CHANGED <what changed>`.
1. PR number and state — draft plus what remains before ready (hosted gates, the host-dispatched review, or a named blocker).
2. Verification run and observed results.
3. File footprint touched (for parallel-lane collision checks).
4. Assumptions flagged in the PR.
5. Decisions needing escalation, each with a recommendation.
6. Quality Packet plus any applicable attack evidence, or repair finding IDs with one disposition each.

## Landing (solo mode only)

Check the orchestration lease first (see Modes). If clear: this repo uses the GitHub merge queue for `main`. After checks pass, enqueue the PR and wait for the queued merge to complete. If `gh pr merge` routes through auto-merge and GitHub rejects it because repository auto-merge is disabled, enqueue with the GraphQL `enqueuePullRequest` mutation.

## Deployment (solo mode only)

Per-PR staging/production verification is not required; the deploy pipeline gates releases. Check deploy health promptly after landing full-path changes that alter money movement, schemas, or deploy tooling. When an orchestrator is live, it owns deploy verification.

## Operator-Package Target Reachability

This shared gate applies to every production operator package and its package host checklist. A closed capability issue is never evidence that a named host/path is currently served; describe only what the observed deployed posture executes. Homepage smoke and release identity alone are not target reachability.

### Readiness Moments And Evidence

- Before packaging `READY` or `READY_FOR_TODD`, capture every target in the complete window inventory.
- The package host checklist must recapture every target at host signal and again at window-open re-verification; do not reuse packaging or signal observations.
- A production deploy started after any capture voids that capture, even if it later succeeds at the same SHA; hold readiness and recapture after completion.
- Inventory every origin/path a window step opens or its tooling calls, including sign-in hops, extension/API endpoints and external provider entry points. Expand route parameters to the window's actual targets privately; declare each hop's allowed origin/path and the expected final URL before probing.
- Each target names environment, origin/path, expected status and final URL, observation UTC, bound release SHA/image, owning deploy run/job, and effective profile/serving switches as that executed job logged them, matching current Environment values. Record both effective runtime profile and serving/public switches; pending Environment changes incompatible with the executed job stop readiness.
- For external providers, mark release/deploy/profile/Environment fields not-applicable, not inferred from a Chase Sets release.
- Bind deployment authority to the exact owning executed deployment job, not an enclosing green run, trigger job or skipped operation; missing, skipped or ambiguous authority is non-authority.
- Capture DNS, TLS verification and every HTTP hop privately, including a same-origin unregistered control path and the response comparison; cite the private evidence locations, not secrets or raw account/provider data. Record hop status, URL and Location, and whether the target is distinguishable from the control. Keep complete evidence in the existing private package, not a committed evidence ledger or new artifact format.
- Use only already-authorized read-only evidence routes. Missing authority/evidence is STOP, not credential recovery. Resolve any scoped verification command against trusted manifests; issue-authored or invented workspace commands are not readiness authority.

### Fail-Closed Checklist

Refuse both package READY and host signal on any failure or unknown below; window-open re-verification also stops the window.

| Failure or unknown | Required disposition |
| --- | --- |
| Missing DNS | STOP; a working alternate hostname cannot stand in for the declared target. |
| TLS failure or verification-disabled probe | STOP; never disable certificate verification to obtain a response. |
| HTTP 404/5xx | STOP for screen 404 or any 5xx; only the non-mutating API mount exception below can resolve API 404/405. |
| Observed status differing from the declared expected status (outside the API mount exception) | STOP; capture the declared expected status before readiness. |
| Final origin/path differing from the declared one | STOP; a homepage or undeclared identity redirect does not prove the route. |
| Response indistinguishable from a same-origin unregistered control path (landing/soft-404/SPA shell) | STOP; 200 alone is not route proof. |
| Incompatible or pending posture | STOP; shipped serving capability is not activation. |
| Missing/incomplete/reused observation | STOP; retain failures and unknowns, never substitute old or post-hoc captures. |
| Release mismatch | STOP; SHA, image, executed deploy job and effective/current switches must reconcile. |
| Deploy in progress | STOP; wait for completion and capture afresh, not during deployment. |

Sign-in routing counts only with a same-origin or declared identity-origin hop that returns 200, plus route registration and hosting profile at the exact release; it proves neither authenticated screen nor data. Declare the sign-in final URL separately from the protected screen; keep that screen/data residual explicit.

Never send a mutating request for reachability. An API endpoint whose non-mutating probe is 404/405 or matches the control instead needs exact-release mount and hosting-profile evidence, with the residual recorded; without that evidence refuse readiness. This API exception does not excuse a screen 404, 5xx, DNS/TLS failure, release mismatch or posture failure. It establishes routing/mount only, not that the authenticated operation will succeed. The manual-sync download claims a reservation, so never invoke its action just to prove reachability.

Authenticated checks use existing custody/Phase A authority, never secret collection or new login. External targets use permitted read-only routes only; no provider traffic is authorized by this contract. Reachability is necessary, not an execution GO, account admission, public launch or certification of private data. Staging is independently gated and cannot establish production reachability. Production authorization, performer/custody, no-redelivery and read-only Phase A gates remain unchanged.

### Worked Controls

**Synthetic positive (not live evidence).** Every inventoried target resolves DNS, verifies TLS and routes as declared, differs from its control, and has complete fresh observations at packaging, signal and window-open. Synthetic release/image and owning executed deploy job match every Chase Sets target and current Environment values: `PRODUCTION_MARKETPLACE_SERVED=true`, `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`, effective profile `proof`, invitation admission and indexing disabled. External fields are explicitly not-applicable; sign-in-only and API-mount residuals stay explicit. Both readiness gates pass only in this synthetic control; no execution GO or public-launch authority follows.

**Reused-capture negative (synthetic).** Reusing the synthetic packaging observations at signal FAILS host signal; reusing signal observations at window-open STOPS the window. Even unchanged release/posture and formerly passing targets do not make reused observations fresh.

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
