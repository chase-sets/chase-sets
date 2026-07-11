# Platform Policy Conventions

Every runtime-configurable business value has exactly one tier, and every tier has exactly one owning mechanism. This doc names the tiers, gives the decision rule for which tier a new value belongs to, and points at the machinery and guard that keep the placement from drifting.

## Background

The 2026-07-05 hardcoded-values audit (epic #4294) found business values duplicated as SQL literals (`INTERVAL '2 days'`, `amount >= 250`, repeated across query functions) and as compiled TS constants scattered across contexts. `infrastructure/platform-policy/define-policy.ts` generalizes the pattern that already worked for commercial terms -- an event-sourced, effective-windowed, audited, admin-managed policy document with a compiled fallback -- into shared machinery any bounded context can adopt for its own values. Every Tier 1-3 finding the audit named now resolves through it.

## The Three Tiers

### Tier: platform policy (`definePolicy`)

Runtime-configurable business values: money amounts, thresholds, deadlines, rate limits, and gates that an operator should be able to revise without a deploy, with audit history and an effective window.

- **Mechanism**: `definePolicy` (`infrastructure/platform-policy/define-policy.ts`). The owning context declares a `policyKey`, a `schemaSummary`, a `decodeValue` validator, and a compiled `defaultValue`.
- **Compiled fallback posture**: the `defaultValue` is a *sanctioned* fail-safe, not duplication -- it is the single source used whenever no policy document is active (an empty policy table can never break a hot path). This is the opposite of the audit's original finding, where the same number was compiled independently in multiple places; here there is exactly one compiled value, and it is the schema's own default.
- **Examples**: `bounded-contexts/commercial-terms/features/checkout-processing-fee/domain/policy.ts`, `bounded-contexts/commercial-terms/features/authenticity-fee/domain/policy.ts`, `bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts`, `bounded-contexts/settlement/features/payouts/domain/payout-policy.ts`, `bounded-contexts/platform-operations/features/support-requests/domain/support-deadline-policy.ts`, `bounded-contexts/platform-operations/features/rate-limit-policy/domain/rate-limit-policy.ts`, `bounded-contexts/marketplace/features/listings/domain/listing-gate-policy.ts`.

### Tier: environment configuration

Values that need runtime configurability but must **never** be admin-editable, because the deploy-review friction is the security control, not an oversight.

- **Mechanism**: bounded env vars, validated at host boot (`getBoundedDurationEnv` and equivalents), never routed through `definePolicy`.
- **Decision rule**: a value is env-tier, not policy-tier, when a compromised admin session changing it live would itself be the attack. Security lifetimes are the canonical case: session TTL, magic-link/challenge/social-login-state TTLs, guest-checkout token TTL, and UCP OAuth token TTLs. See `bounded-contexts/auth/docs/security-lifetimes.md` and the exclusion comment at the top of `infrastructure/platform-policy/define-policy.ts`. If a future slice is tempted to `definePolicy` one of these, that is the wrong direction -- revert to env.

### Tier: compiled constant

Values that are not business policy at all: protocol constants, page sizes, pagination/result-count caps, and other tuning parameters with no operator-facing meaning.

- **Mechanism**: an ordinary exported `const`, no policy machinery needed.
- **Decision rule**: would an operator ever plausibly want to change this without a deploy, and does the value express a business term (a fee, a deadline, a threshold, a limit with commercial meaning)? If no to either, it stays compiled. A result-count cap on a search-relevance query is a compiled constant; a high-dollar listing-gate threshold is a policy.

## Decision Rules (Applying The Tiers)

1. **Name the value's failure mode.** If a wrong value costs money, extends or shortens a customer-facing deadline, or changes who can transact, it is a business value -- start at platform policy.
2. **Ask who should be able to change it without a deploy.** If the answer is "an authorized operator, with an audit trail" -- platform policy. If the answer is "nobody, ever, without a deploy and code review" -- environment configuration. If the answer is "no one needs to, it's not a business term" -- compiled constant.
3. **Context ownership does not change.** The bounded context that owns the behavior owns the policy schema, exactly as it would own a compiled constant -- there is no shared "settings" or "config" context. Settlement owns clearance policy; Platform Operations owns support-flow deadlines and rate limits; Marketplace owns the listing gate.
4. **One compiled default, not several.** A policy's `defaultValue` is the only compiled representation of that value anywhere in the codebase. If a seed script, a schema default, and an exported constant all encode the same number, that is the duplication bug this convention exists to prevent -- derive the others from the policy's default instead of restating it.
5. **Bounds live with the schema, not as a duplicate.** A policy's `decodeValue` validator may reference exported bounds constants (for example `MIN_SUPPORT_DEADLINE_HOURS`/`MAX_SUPPORT_DEADLINE_HOURS` in `bounded-contexts/platform-operations/features/support-requests/domain/support-deadline-policy.ts`). Those constants are the schema's own validation, declared in the same file that calls `definePolicy` -- they are the single source, not a second copy.

## Feature Flags Are Not Policy

Platform policies are versioned business values with effective windows and audit history. Feature flags are rollout state that decides who can reach a surface. They share machinery (`definePolicy` is not the flag provider, but both may live behind similar admin/audit primitives) but never share meaning: a policy revision must never gate whether a surface is reachable, and a flag must never carry a business number. See [ADR 0019: Feature Flags And Rollout Boundaries](../adr/0019-feature-flags-rollout-boundaries.md) for the full boundary and the deciders/evolvers exclusion that keeps event replay deterministic.

## Enforcement

`scripts/check-structure/business-literal-guard.mjs` runs in `verify:static` (via `check:structure`) and flags three shapes of regression:

1. Hardcoded SQL `INTERVAL '<n> <unit>'` literals (day-scale or larger) in bounded-context source.
2. Hardcoded money-comparison literals (`<money-identifier> >= <number>`-shaped) in bounded-context source.
3. Newly exported `*_THRESHOLD`/`*_LIMIT`/`*_FEE`/`*_HOURS`-style constants outside a policy's own owning file.

The guard is deliberately cheap -- name-pattern and SQL-literal regex checks, no semantic analysis -- so it stays low-false-positive rather than blocking the repo on noise. Reviewed exceptions (operational retry/reporting windows, page-size constants, pre-existing out-of-scope thresholds) live in `scripts/check-structure/business-literal-allowlist.mjs`, each with a named reason and reference. The allowlist ratchets: when a listed value gets a platform-policy migration slice, delete its entry in the same PR.

## Related

- [Bounded Context Structure](./bounded-context-structure.md) -- directory, manifest, and structure-gate conventions this guard extends.
- [Settings Ownership](./settings-ownership.md) -- the parallel decision rule for presentation/behavior settings, not business-policy values.
- [ADR 0019: Feature Flags And Rollout Boundaries](../adr/0019-feature-flags-rollout-boundaries.md) -- the policy-vs-flag boundary.
- `bounded-contexts/auth/docs/security-lifetimes.md` -- the full env-tier rationale and value table for security lifetimes.
