# Authoring a Pricing Goal

A new pricing strategy is one Pricing Goal module plus a passing Conformance
Kit run. Goals contribute decisions only: the repricing engine, policy
authoring, dry runs, preview and the evaluated-event trace resolve a goal by
`(id, version)` and never switch on its id. This guide is the contract and the
steps. Each step names the test that proves it, and
`tests/conformance/fixture-goal-end-to-end.test.ts` fails if a step and its
test drift apart.

## The contract

A goal is a `PricingGoalDefinition`
(`features/repricing-policies/domain/goals/registry.ts`, #9307):

| Field | Meaning |
| --- | --- |
| `id` | Lower-case kebab id, stable across versions. |
| `version` | Positive integer. A changed decision is a new version (see Versioning). |
| `lifecycle` | `selectable`, `shadow` or `retired` (#9310). Version 1 defaults to `selectable`, later versions to `shadow`. |
| `parameterSchema` | Numeric parameters, each with a default inside finite inclusive bounds. Fees and the Daily Return Hurdle are Economics facts, never parameters. |
| `requiredCurveFeatures` | Demand Curve features the goal reads, in the order it reports them missing. |
| `requiresEconomics` | Whether the goal reads resolved Economics. A goal that does not require it never sees it. |
| `solve` | Pure: the same curve, parameters and Economics always give the same Goal Decision or unavailable result. |
| `explain` | Values only, keyed to the goal's own id and version; seller-facing copy belongs to the surface that renders it. |
| `solvePortfolio` | Optional, portfolio goals only (#7710): one Portfolio Plan across an explicit listing set. A round resolves it once per policy and anchor and applies it per listing through every stage. |

Write a goal with `definePricingGoal`. It validates parameters and answers
`curve-empty`, `curve-feature-missing:<feature>`, `economics-unavailable` and
`economics-currency-mismatch` before your `select` runs, so `select` only picks
a curve point.

A goal whose answer depends on the other listings, such as `hold-value` or
`cash-target`, is written with `definePortfolioGoal`
(`features/repricing-policies/domain/goals/portfolio-goal.ts`): its `resolve`
picks one target horizon for a prepared portfolio, and its `solve` is the plan
of a one-listing portfolio at the listing's `currentPriceAmount`. The Conformance
Kit's portfolio property runs over every goal that declares `solvePortfolio`.

## Steps

The fixture goal `fixture-flat-offset`
(`tests/conformance/fixture-flat-offset.ts`) follows these steps. It lives only
in tests and is never registered in production.

### Step 1 — Write the goal as one module with definePricingGoal

Add `features/repricing-policies/domain/goals/<id>.ts` exporting one
`definePricingGoal({ id, version: 1, parameterSchema, requiredCurveFeatures,
requiresEconomics, select, drivers })`. Reuse `curve-math.ts` for curve
arithmetic, and keep the goal's math in this module.

Proof: [Step 1 — Write the goal as one module with definePricingGoal](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 2 — Register it in the Pricing Goal registry

Add the goal to the list `features/repricing-policies/domain/domain.ts` passes
to `createPricingGoalRegistry`. The registry registers each entry through
`registerPricingGoal`, which rejects a malformed id, version or parameter
bound, a duplicate `(id, version)` and a second `shadow` version of one id.
Edit nothing in the engine, authoring, dry run or preview.

Proof: [Step 2 — Register it in the Pricing Goal registry](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 3 — Declare its curve claims and Golden Decision, and pass the Conformance Kit

Add the goal's entry to `tests/conformance/goal-declarations.ts`, keyed
`<id>@<version>`:

- `priceScalesWithCurve`: `true` only if scaling every curve price up never
  lowers the goal's price (and scaling down never raises it).
- `golden`: the goal's decision at default parameters on each shared fixture
  curve. Check each value against an independent expectation, such as the
  pinned app's recorded decisions, before you record it.

`tests/conformance/goal-conformance.test.ts` then runs every registered goal
through the kit: a declaration and Golden Decision on every fixture curve,
determinism over frozen inputs, parameter bounds and defaults, a stable
unavailable result for each declared missing input, the declared curve
response, an explanation for every decision, shadow evaluation that leaves the
incumbent unchanged, and the Golden Decision.

Proof: [Step 3 — Declare its curve claims and Golden Decision, and pass the Conformance Kit](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 4 — Authoring and dry runs validate it as a curve-objective anchor

No change. A `curve-objective` anchor naming a `selectable` version is
accepted, its defaults are filled into the recorded policy, and unknown or
out-of-bounds parameters are rejected by name.

Proof: [Step 4 — Authoring and dry runs validate it as a curve-objective anchor](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 5 — Preview prices listings with it

No change. The round planner behind preview prices a listing from the goal's
decision and traces the goal at the final price.

Proof: [Step 5 — Preview prices listings with it](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 6 — The evaluated listing trace records its Goal Version

No change. The listing trace the `pricing.repricing-policy.evaluated` event
carries records the goal id, version and curve version at the final price.
This is the fact the Forecast Ledger projects; see Step 11.

Proof: [Step 6 — The evaluated listing trace records its Goal Version](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 7 — Ship a changed decision as a new version that runs in shadow first

Define the changed goal with the next version. It registers as `shadow`:
sellers cannot author it, and each live round evaluates it beside the
incumbent on the same captured inputs, records a shadow trace, and emits
nothing. Recorded policies carry their filled parameters, so a change that
only moves a default does not change a recorded listing's shadow price.

Proof: [Step 7 — Ship a changed decision as a new version that runs in shadow first](../tests/conformance/fixture-goal-end-to-end.test.ts)

### Step 8 — Give a changed decision a new version with its own Golden Decision

Never edit a recorded Golden Decision to match new behaviour. If a goal's
decision on a fixture curve changes, the kit fails that version; add the new
version with its own `goal-declarations.ts` entry, and keep the old version's
entry until the old version is removed.

Proof: [Step 8 — Give a changed decision a new version with its own Golden Decision](../tests/conformance/goal-version-golden.test.ts)

### Step 9 — Prove every registered Forecast Kind through the Conformance Kit

Every kind the Forecast Kind registry ([#7708 Record every price forecast and grade it against realized sales](https://github.com/chase-sets/chase-sets/issues/7708))
registers passes the Forecast Kind suite. Inputs are evaluation-producer values,
unavailable states return null only where the kind reads that evidence, and each
result is finite, positive and stable.

Proof: [Step 9 — Prove every registered Forecast Kind through the Conformance Kit](../tests/conformance/forecast-kind-conformance.test.ts)

### Step 10 — Show the fixture goal in Pricing Health picker and comparison

The test-only `fixture-flat-offset` goal is registered through the same registry
port used by the real composition. The Pricing Health surface ([#7709 Compare goals on a Pricing Health surface with a verdict](https://github.com/chase-sets/chase-sets/issues/7709))
renders it in the registry-driven picker and comparison without a surface edit.

Proof: [Step 10 — Show the fixture goal in Pricing Health picker and comparison](../tests/conformance/fixture-goal-pricing-health.db.test.tsx)

### Step 11 — Project the fixture goal's incumbent and shadow traces to the Forecast Ledger

The fixture goal's incumbent and shadow evaluations each write one
Forecast Ledger ([#7708 Record every price forecast and grade it against realized sales](https://github.com/chase-sets/chase-sets/issues/7708)) row
carrying its goal id, Goal Version, curve version and every registered forecast.
The proof invokes the context's subscribed projection handler, with no ledger or
engine edit.

Proof: [Step 11 — Project the fixture goal's incumbent and shadow traces to the Forecast Ledger](../tests/conformance/fixture-goal-ledger.db.test.ts)

## Shadow and adoption

The #9310 lifecycle governs adoption. At most one `shadow` version exists per
goal id. A lifecycle change is a reviewed registration change, never a job.
Selecting a version above 1 cites its graded adoption evidence: the Forecast
Grade from [#7708 Record every price forecast and grade it against realized sales](https://github.com/chase-sets/chase-sets/issues/7708), which grades every shadow trace against realized sales.
Grading and its adoption gate are not yet on `main`. Until they land, keep
later versions in `shadow`. Retire a version by setting it `retired`. A
recorded anchor that names it then exhausts as `goal-retired`, and the chain
continues.

## Versioning

A Goal Version is the pair `(id, version)`. Anything that changes a Golden
Decision is a new version: math, defaults, required features, or Economics use.
A change that leaves every Golden Decision intact keeps the version. The kit
enforces this (Step 8), and `goal-conformance.test.ts` requires the
declarations to name exactly the registered versions.

## Before a goal reaches sellers

The seller-facing goal label is copy, not engine code. Add it to
`repricingGoalLabel` in `features/repricing-policies/ui/policy-copy.ts` and to
the locale catalogue. `features/repricing-policies/ui/policy-controls.test.ts`
fails a registered goal whose label is its id. The fixture goal is never shown
to sellers, so its end-to-end test does not cover this step. The Pricing
Health surface is proved by Step 10 above; the fixture remains test-only.

## Other registries in the kit

Each Pricing registry runs through the same harness
(`tests/conformance/kit.ts`). Each run reads entries from the composition that
registers them. Each run below also passes its factory's module to `vi.mock`
through the kit's `recordRegistrations`, which records every entry production
registers: the factory's initial entries and every `register<Name>` call,
including registration ports. The run then fails any recorded registration it
does not exercise, and any exercised entry that is neither recorded nor listed
in its `unregisteredKeys`:

| Registry | Run | Contract checked |
| --- | --- | --- |
| Guardrail kinds (#9308) | `guardrail-conformance.test.ts` | Parameter validation, pure `apply` over `GuardrailContext`, acts on its hit and is inert otherwise, idempotent, records its hit in the evaluation, never raises a price above the seller's ceiling. Each authorable kind declares its scenario, which the `RepricingGuardrail` union enforces at compile time. |
| Curve builders | `curve-builder-conformance.test.ts` | Identity, deterministic loads over frozen inputs, sales of the requested variant and language in one sale shape, the window's sales limit, no sales when no evidence is stored. |
| Economics providers | `economics-provider-conformance.test.ts` | Deterministic resolution, source Economics in the request currency under the provider's identity, unmodified requests, a stable unavailable reason when the source cannot price. The native marketplace provider and the unregistered-channel result are its `unregisteredKeys`; an exact or fallback provider registered in production fails the run until it has an entry. |
| Forecast kinds (#7708) | `forecast-kind-conformance.test.ts` | The run binds `forecastKindDefinitions` as `production` and exercises every kind it enumerates, under unique names, with the Forecast Kind property set proved by Step 9. |

A registry the factory's own module constructs cannot be recorded: that module
calls the factory directly, and the mock wraps only its export. Its run passes
the construction's exported enumeration as `production` instead, for example
`export const definitions = registry.definitions` beside
`const registry = createRegistry([...])`. The run then fails any entry that
enumeration returns and the run does not exercise. A test-built registry or a
hand-written list is not accepted as `production`.

`scripts/check-structure/pricing-registry-conformance.mjs` finds every
registry in Pricing production code by code shape: a function that builds a
`Map` or `Set` in its own body and returns a `register<Name>` member. It fails
when a registry has no `describeConformance({ registry })` run, or when that
`describeConformance` is not the kit's export. It also fails when a run neither
mocks the registry's module for recording nor passes a `production`
enumeration. That enumeration must resolve to a production module's
`const <name> = <construction>.<member>`, where `<construction>` is that
module's `const <construction> = <factory>(...)` of the run's registry and
`<member>` is a non-`register` member the factory returns. Finally, it fails
when a production module constructs the registry and no run covers it. A run
covers a construction it binds as `production`. A recording run covers one in
any module but the factory's own, if the run executes that module. Executing
means following value imports and re-exports, including `export *`,
transitively. Type-only imports and imports whose bindings are never used do
not count.
