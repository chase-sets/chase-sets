# ADR 0019: Feature Flags And Rollout Boundaries

## Status

Accepted for milestone #114

Supersedes the pre-launch "no retained feature flags" posture recorded in the release-process runbook for product/runtime feature flags. CI release-health rollout policy remains a delivery-only mechanism.

## Context

Milestone #51 removed pre-launch feature-flag machinery and added `scripts/check-structure/software-delivery-concepts.mjs` so release dashboards, release controls, production locks, production markers, deployment canaries, and deploy-time feature rollout state could not drift back into product code.

That decision was right before launch: flags would have added a second control plane before the platform had enough traffic and operator evidence to justify it. Milestone #114 is the planned revisit. Chase Sets now needs product-surface rollout, beta cohort access, kill switches, dark-launch read routing, MCP tool availability gates, and experiment exposure tracking.

The event-sourced constraint is non-negotiable. Domain deciders, evolvers, event payload semantics, and domain types must stay deterministic under replay. A flag check inside a decider would make historic replay depend on mutable flag state at a past moment. That would either fork domain meaning or require a complete flag-state time machine for every event.

## Decision

Adopt feature flags behind the OpenFeature SDK contract, with a Chase Sets provider backed by platform-policy machinery unless later evidence justifies a hosted flag service.

Feature flags gate surfaces, not domain decisions:

1. Allowed: route mounts, API entry points, UI branches, MCP tool availability, anonymous or account access gates, and projection read-model selection at a read-router edge.
2. Forbidden: deciders, evolvers, event constructors, event payload shape, aggregate state transitions, domain services, and domain type definitions.
3. New domain behavior rolls out by access. The domain capability itself is deterministic once reached.
4. Dark launches compare alternate read models or surfaces from outside domain decision code. They do not create alternate event semantics.

Placement follows the existing bounded-context model:

1. Platform-runtime infrastructure owns the OpenFeature provider contract and evaluation mechanics.
2. Operator console owns flag document administration, stale-flag hygiene, and kill-switch operation.
3. Bounded contexts may consume evaluated flag decisions at composition edges such as `routes/`, `features/*/api/`, and `features/*/ui/`.
4. Deployables remain thin composition roots and may mount or omit surfaces using evaluated flags.
5. Bounded-context `features/*/domain/` code must not import OpenFeature, flag providers, or flag clients.

Platform policy and feature flags share machinery but not meaning. Platform policies are versioned business values with effective windows, audit history, and domain-facing resolution. Feature flags are rollout state used to decide who can reach a surface. Issue #4293 will document the platform-policy convention; that convention should cross-link this ADR so policy values do not become rollout flags, and rollout flags do not become business terms.

## Build-Versus-Adopt Record

Build the provider now because the near-term needs are narrow and Chase Sets already has the required primitives: event-sourced policy documents, effective windows, identity/account badges, operator audit history, and Postgres-backed read models.

OpenFeature is the portability boundary. Call sites should depend on the SDK contract and Chase Sets context-building helpers, not on storage details. A later migration to Unleash, GrowthBook, PostHog, or another provider must not require changing bounded-context call sites.

## Alternatives Considered

### Keep Feature Flags Out Of Product Code

Rejected for milestone #114. The platform now needs beta waves, kill switches, tool gating, and dark-launch read routing. Continuing with only CI release-health policy would force product behavior into delivery tooling or require broad PR deploys for every cohort change.

### Adopt A Hosted Flag Platform Immediately

Rejected for now. Hosted products add cost, another operational dependency, and another source of identity/cohort truth before Chase Sets has enough flag volume to need them. This can reopen when traffic, experimentation count, or multi-service topology makes a dedicated provider cheaper than the home-built provider.

### Put Flags In Domain Deciders

Rejected permanently unless a future ADR replaces the event-sourcing model itself. Decider flags break replay determinism and make the same historic command/event stream mean different things under different flag state.

### Use Platform Policy For Everything

Rejected as a vocabulary collapse. Business values and rollout state have different lifecycles, owners, review criteria, and UI expectations. They may share implementation primitives, but they should not share a domain concept.

## Guardrails

`scripts/check-structure/software-delivery-concepts.mjs` enforces the boundary:

- legacy delivery concepts remain banned from bounded-context and deployable source;
- feature-rollout vocabulary is allowed at composition edges and denied elsewhere;
- OpenFeature imports, feature-flag clients, and typed flag-value evaluation are denied from bounded-context domain files;
- guard tests include an allowed edge fixture and a decider violation fixture.

Future provider slices should extend the guard only when they add a concrete new call surface. Do not weaken the domain prohibition to make implementation easier.

## Reopening Criteria

Create a new ADR before replacing the home-built provider or changing the decider rule if one of these becomes true:

- monthly experiment volume requires statistical tooling that would be more expensive to maintain than adopt;
- flags must be evaluated consistently across independently deployed services that cannot share the platform-policy provider safely;
- external compliance, audit, or enterprise requirements demand a hosted approval workflow;
- the platform intentionally changes its event-sourcing replay guarantees.

## Consequences

Milestone #114 can proceed with a provider slice, cohort/beta slices, a flag console, experimentation records, and dark-launch read routing without reopening the pre-launch feature-flag removal.

Milestone #110 remains responsible for platform-policy business values. Issue #4293 should cross-link this ADR when the configuration convention doc lands.

Milestone #51's memory is amended by reference: the old rule remains correct for pre-launch delivery flags and domain decision code, but no longer forbids product-surface feature flags at composition edges.
