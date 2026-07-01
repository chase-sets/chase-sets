# ADR 0016: Profiled Production Topology

## Status

Accepted for milestone #69

## Context

Production has three distinct operating postures: launch landing/admin support, private production proof, and full public marketplace. Before this milestone, that posture was partly encoded through App Platform component names, `production_marketplace_public_enabled`, provider secret validation, and runbook language.

The platform needs a typed contract that can fail closed before routes, provider callbacks, worker groups, or live-money checks are exposed in the wrong posture.

## Decision

Represent production posture with typed runtime profiles named `landing`, `proof`, and `public`.

`CHASE_SETS_RUNTIME_PROFILE` selects the `platform-api` profile. `CHASE_SETS_WORKER_PROFILE` selects the `platform-worker` profile. The selected production mode, API profile, and worker profile must match. The source contract is exported from `@chase-sets/platform-runtime` and implemented in `infrastructure/platform-runtime/runtime-profiles.ts`.

The profiles mean:

- `landing`: landing and admin support only; no public marketplace runtime.
- `proof`: private production marketplace proof for provider and live-money evidence.
- `public`: full public marketplace runtime after launch gates pass.

The contract covers mounted context set, public marketplace route exposure, private proof route exposure, provider callback posture, worker groups, required secret posture, and smoke expectation.

## Alternatives Considered

- Continue with loose environment-variable flags. Rejected because mixed route, worker, and secret posture can drift without one validation point.
- Keep separate deployables per posture. Rejected because it preserves duplicate support/full-platform runtime families and leaves profile intent implicit in component names.
- Tie production promotion only to `production_marketplace_public_enabled`. Rejected because private proof mode needs full-platform provider/live-money behavior without public marketplace launch.

## Consequences

Mixed selections fail closed. A production `landing` mode cannot run a `proof` API profile, and a `proof` mode cannot silently become `public` because a marketplace route is mounted.

Release evidence and topology docs must name the selected mode, API profile, worker profile, secret posture, smoke expectation, and route exposure. New production postures require extending the typed contract first.

This decision supports issues #3212, #3213, #3214, #3216, #3217, #3218, #3220, and #3242.
