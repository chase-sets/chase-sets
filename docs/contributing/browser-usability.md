# Goal-based browser probes

Goal-only browser probes supplement scripted Playwright coverage for touched user flows. They are advisory observations, not CI passes, human-usability certification, or merge authorization. A participant receives user intent without the implementation's solution path; an independent moderator checks the outcome. Start with `gpt-6-luna/medium` under the user-authorized row-6 placement. Record a new baseline when configuration changes.

## Select a goal

Run `pnpm run ops browser:usability select --base origin/main` for a candidate's changed paths. The four versioned goals live in `scripts/browser-usability-goals.mjs`: card variant/availability, seller time away, buyer shipment/problem entry, and condition-problem policy. Selection is a starting point, not coverage certification: the author must add a relevant goal or explain an uncovered UI flow. Do not run all goals on every PR.

This first version is **moderator-driven**, using the desktop browser tool and a fresh subagent. It does not launch agents from GitHub Actions or require new credentials. If browser tooling or an isolated fixture is unavailable, record **not run** with the reason; do not fabricate evidence or block publication on a local environment failure. Existing hosted CI and independent code review remain authoritative.

## Audit a surface

Run `pnpm run ops browser:usability audit` to inspect advisory route coverage, or add `--surface guest`, `buyer`, `seller`, `operator-catalog`, or `operator-workspaces` to show one surface. The read-only command reads tracked files once with `git ls-files`. `unscoped` lists routes without an owner; `invalid` lists routes with multiple scopes or conflicting claims and exclusions. Each surface reports `inScope`, `claimed`, `excluded`, and the `unclaimed` route paths. An unclaimed route is work to consider, not a failed gate. This audit does not visit routes or adjudicate outcomes.

Five modules in `scripts/browser-usability-goals/` own the route scopes; `scripts/browser-usability-goals.mjs` remains the aggregate import. Each exports `{ id, routeScope, goals, excludedRoutes }`. `routeScope` contains anchored regex strings. Each goal retains `id`, `version`, `goal`, `startPath`, `role`, `checks`, and `paths`, and declares:

- `host`: `marketplace`, `public-web`, or `admin-web`; `role`: `guest`, `buyer`, `seller`, or `operator`.
- `oracle`: a moderator-only non-empty outcome instruction for every check, with no extra keys.
- `routes`: scoped repository route paths mapped to a check id. A route claim means the check exercises that route, not merely that it is nearby. `find-card` has no buyer-scope route claim because its discovery pages belong to guest scope; its existing discovery/catalog path prefixes still select it.
- `paths`: non-empty changed-path prefixes that select the goal. An exact `routes` key also selects it on non-shared changes. Shared paths select only goals with `selectOnSharedChange: true`; only the moved four goals opt in initially.
- `permits`: an optional exception to the participant's read-only default. The moderator restores permitted changes afterwards. The payment, postage, external-channel, message, and credential boundary always applies.
- `startSignedIn`: the moderator's starting authentication state; defaults to `false` for guest and `true` otherwise. The moderator signs in, not the participant.

Goal intent must not contain URL path tokens. The participant receives intent, starting URL, task context, and permissions, never `oracle` or `routes`. Exclusions use `{ path, reason }`, must match scope, and cannot also be claimed. Reasons are `layout-only`, `redirect-only`, `error-page`, `provider-step-only`, or `fixture-gap: <missing state>`. `validateBrowserUsabilityGoalModules` is exercised by the focused script tests; coverage itself is not a CI guard. No new goals are introduced by this organization.

## Prepare privately

Commit the candidate locally first. Use the existing browser-e2e sandbox and readiness tooling, with a synthetic account. Do not run writes on staging, production, or a shared account. Obey heavy-verifier admission; do not bypass another lane's lock. See `pnpm run dev:e2e:probe` and `scripts/browser-e2e-readiness.mjs` for the existing service/projection readiness evidence. No new sandbox launcher is required.

The moderator must independently confirm the actual running build, healthy services, projection convergence, fixture ownership/starting state, and exclusive browser authentication. New tabs do not isolate cookies. Run mutable goals serially or use separate browser profiles. Resolve the expected outcome from authoritative fixture/policy data **before** dispatch; never give that answer to the participant. For seller-away, use future dates, an initially empty schedule, and reserve restoration of that same account for the moderator.

Save a private preflight JSON and its supporting files under ignored `artifacts/browser-usability/`. Example shape (replace values with observations, not assertions copied from this example):

```json
{
  "head": "<40-character candidate commit>",
  "origin": "http://localhost:9753",
  "role": "buyer",
  "environment": "isolated-synthetic",
  "observedAt": "<current ISO timestamp>",
  "fixtureId": "buyer-seed-v1",
  "harness": "<browser tool/runtime version>",
  "viewport": "1280x720",
  "locale": "en-US",
  "timezone": "America/Chicago",
  "cachePolicy": "warm",
  "taskContext": "The moderator has signed in the synthetic buyer.",
  "checks": {
    "services": { "status": "pass", "evidence": "services.json" },
    "projections": { "status": "pass", "evidence": "projections.json" },
    "fixture": { "status": "pass", "evidence": "fixture.json" },
    "exclusiveSession": { "status": "pass", "evidence": "session.json" }
  }
}
```

Evidence paths are relative to the preflight's directory and must exist. The CLI checks identity, freshness, scope, and evidence bytes; **the moderator remains responsible for their truth**. This is not a cryptographic attestation of the service build. Never put passwords, auth tokens, personal data, or raw environment dumps in evidence. `taskContext` is disclosed to the participant: include only necessary scenario inputs, such as away dates, not expected controls, outcomes, or fault conditions.

```powershell
pnpm run ops browser:usability prepare --goal buyer-shipment --origin http://localhost:9753 --preflight artifacts/browser-usability/preflight.json --out artifacts/browser-usability/buyer-01
```

The output is a new manifest, private preflight copy, and `participant.md`. Preparation refuses dirty candidates, stale/nonpassing preflight, remote origins, and reuse of an attempt directory. The default task budget is six minutes and 35 actions. Queue/bootstrap time is separate from the task clock. Clean control and deliberately broken calibration fixtures must have distinct fixture IDs, never masquerade as product evidence.

## Run a fresh participant

Use a fresh `gpt-6-luna/medium` subagent without conversation history. Give it only `participant.md`, the run directory, the helper module's absolute path, and the following browser-wrapper instructions. Do not provide source, route hints, tests, private outcome evidence, or earlier participant reports. Pin exact model/effort, row 6, `override-Todd`, and record cost as unknown unless measured.

Initialize the browser tool according to its first-call contract, creating a hidden `about:blank` tab. In a subsequent browser-tool JavaScript call, import the helper without reading its implementation:

```js
var { createBrowserUsabilitySession } = await import("file:///D:/path/to/worktree/scripts/browser-usability-session.mjs");
var session = createBrowserUsabilitySession({ directory: "D:/path/to/run", tab });
var observation = await session.start();
await nodeRepl.emitImage(observation.screenshot);
nodeRepl.write(observation.state);
```

Use the observed screenshot to select each target. AX is allowed for reading and activation only when the target is visibly discoverable. All observations/actions go through the wrapper, not the raw tab:

```js
var observation = await session.act("click", [freshIndex], "visible target description");
await nodeRepl.emitImage(observation.screenshot);
nodeRepl.write(observation.state);
// On a tool error, call session.observe() and inspect both outputs before retrying.
// End with the supported answer, explicitly preserving unknowns:
await session.finish({ status: "partial", answer: "...", obstacles: ["..."] });
```

`act` supports click, typeText, pressKey, scroll, back, reload, and advertised secondary actions. It refuses direct route guessing, requires a new observation after every action, and saves PNGs automatically. `finish` closes the participant tab; the moderator uses a separate clean route for verification. The Node timer closes the tab at the deadline even while the model is thinking and preserves `timed-out`. Calls that hang are bounded; late completion cannot replace timeout. Failed calls count toward the action budget. Do not silently rerun a failed attempt or promote participant `complete` to a pass.

The wrapper is instrumentation, **not an adversarial security sandbox**. It cannot prevent a participant deliberately using other tools, prove it looked at a screenshot, or undo an already-submitted command. The moderator must enforce tool/origin restrictions and synthetic-only permissions. A browser-tool process crash may prevent its timer from running; a `running` receipt after process loss is incomplete evidence, never a pass. The host interrupts such a participant, closes its tab, and retains the incomplete attempt.

## Check the outcome independently

The moderator reads `run.json`, reobserves the actual outcome, and creates separate adjudication evidence. Each goal names required checks. For seller-away, check exact dates, canonical command/event and fresh read-model state, a clean-route revisit without receipt parameters, and restoration. A toast is not evidence of persistence. For buyer-shipment, reaching generic instructions is not reaching the correct report form. For policy answers, compare against the authoritative policy, not just the participant's first page. Preserve an environment-invalid result separately from a product failure.

Use deterministic assertions when the outcome is machine-checkable; retain their output alongside screenshots. The CLI validates that required evidence is supplied, **not its semantics**. Never have the participant generate its own independent checks. Existing Playwright remains the deterministic regression layer, including seller clean-route read-back in `deployables/marketplace/e2e/seller-time-away-capacity.spec.ts`.

Adjudication JSON shape:

```json
{
  "runId": "<manifest runId>",
  "head": "<manifest head>",
  "runSha256": "<SHA-256 of exact run.json bytes>",
  "reviewer": "<independent moderator or verifier identity>",
  "verdict": "partial",
  "checks": {
    "shipment-identity": { "status": "pass", "reason": "...", "evidence": "shipment.png" },
    "delivery-status-and-time": { "status": "unknown", "reason": "...", "evidence": "shipment.png" },
    "problem-entry": { "status": "fail", "reason": "...", "evidence": "final-state.png" }
  }
}
```

Verdicts: `verified-complete`, `partial`, `incorrect`, `blocked`, `environment-invalid`. Check status: `pass`, `fail`, `unknown`. Evidence paths are relative to this JSON's directory. Run `pnpm run ops browser:usability adjudicate --run <directory> --evidence <file>`. It binds exact run bytes/head, requires every goal check, and cannot pass a timeout or partial participant result. Receipts cannot be overwritten; corrections belong in a new, explicitly identified attempt rather than silently replacing evidence.

## Compare and report

Run `pnpm run ops browser:usability compare --candidate <directory> --baseline <directory>`, repeating `--baseline` for each baseline. At least five distinct, independently correct, matching runs are required. Goal/version/fingerprint, task-context fingerprint, starting path/role, time/action budgets, fixture, exact model/effort, browser mode/harness, viewport, locale/timezone, cache policy, and timing version must match. Origins may differ between isolated base/candidate runtimes. Bump the goal version when changing its intent or checks. Keep failed and incorrect runs in the experiment's overall completion counts, not its success-latency distribution.

Initial advisory warning: more than 2x baseline median **and** more than 60 seconds extra. This is a triage threshold, not statistical significance. Repeat a flagged case once with a fresh participant and healthy fixture, preserving the first attempt. Use sequential, interleaved base/candidate runs to reduce contention/order bias. Inspect actions and per-call durations before attributing delay to UX; do not call the remainder human thinking time. A task that reaches its enforced budget is a timeout, not a slow success.

Include a compact result in the PR's Verification section: goal/version; exact build/model; independent verdict; task time and actions; evidence paths; tool/environment limitations; and any follow-up. Record not-run coverage honestly. Reproduced defects follow existing review severity rules and become deterministic regression tests. The probe receipt itself never authorizes readiness or landing.

On model, prompt, or browser changes, rerun known-good and known-broken controls (hidden target, misleading copy, unavailable page, delay, controlled stale read-back). Keep calibration distinct from real product observations. The focused recorder tests cover timeout, partial/false-pass rejection, evidence binding, and timing selection; they do not certify a model's detection rate. Use occasional human sessions for intuitiveness.

Restore mutable fixtures, close owned tabs, and stop only owned sandbox processes when finished. Retain evidence under ignored `artifacts/`; do not commit screenshots, experiment ledgers, or credentials.
