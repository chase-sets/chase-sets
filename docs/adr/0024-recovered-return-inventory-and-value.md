# ADR 0024: Recovered Return Inventory And Protection Recovery

## Status

Accepted for the recovered-return handoff and disposition capability.

## Context

Facility intake establishes physical custody but does not establish product identity, legal ownership, or authority to resell or dispose of an item. Treating intake as ordinary sellable stock would create an unsafe shortcut around inspection, authenticity policy, abandoned-property rules, and evidence retention. Recovered proceeds and costs also cannot rewrite the historic buyer refund: the refund and its platform-funded coverage are immutable financial facts.

## Decision

Inventory owns a distinct event-sourced `RecoveredItem` aggregate. One deterministic recovered-item identity is derived from each Return Shipment, making a replayed facility-intake fact a no-op. The item begins in quarantine or awaiting identification. It does not create ordinary available Inventory stock and cannot publish a sellable fact until product identity, condition inspection, explicit disposition authority, and any policy-required authenticity review are complete.

Disposition authority records the legal owner, authority kind, allowed actions, policy version, acting operator, and evidence references. Return to the original seller or buyer, platform resale, liquidation, donation, destruction, and carrier claim all require matching authority. Lost or unresolved is the only action that may preserve unknown ownership because it records custody truth rather than exercising ownership rights. Corrections and duplicate merges are append-only.

Inventory publishes separate versioned facts when a recovered item becomes sellable, transfers custody, reaches terminal disposition, or reports recovered value. Gross proceeds and disposition costs are preserved separately for resale, liquidation, carrier claims, postage refunds, and direct disposition costs.

Settlement consumes recovered-value facts and attributes each posting to the settled `ProtectionCoverage` selected by the shared `remedyId`. It emits an immutable `settlement.protection-coverage.recovery-posted.v1` fact. Net recovery is gross minus cost and replenishes protection-pool availability; a cost greater than gross reduces availability. This records recovery alongside the original consumption and never changes the refund or coverage settlement event.

## Policy And Legal Preconditions

The active recovered-return policy must address ownership transfer under the marketplace terms, explicit consent, abandoned-property waiting periods, carrier settlement, and legal-review authority. The same policy must define jurisdiction-specific waiting periods and required evidence for resale, return, liquidation, donation, destruction, and unresolved loss. Destruction requires evidence of the item and completed destruction; donation requires recipient evidence; returns require a target account; resale requires platform ownership and an Inventory custody location. Evidence retention and operator access remain permission-scoped.

Policy changes create new versions. They do not retroactively authorize an older item, and a disposition command must match the version on its recorded authority. Authenticity is composed only when that policy explicitly requires it; Inventory stores the resulting reference and outcome without importing Authenticity persistence.

## Alternatives Considered

- Creating an ordinary Inventory Item at intake was rejected because quarantine and ownership checks would be bypassed by listing flows.
- Letting Support manage recovered stock was rejected because case persistence is not physical custody or inventory truth.
- Netting proceeds into the original refund was rejected because it rewrites customer-facing payment history and loses gross-versus-cost margin evidence.
- Keeping recovery outside the protection pool was rejected because it would understate available protection funds after verified recovery.

## Consequences

Projection rebuilds reproduce the custody audit, disposition state, recovery values, and settlement attribution from immutable events. Operators receive an Inventory-owned workflow and permission-scoped evidence view. The facility-intake producer must land before the end-to-end handoff runs, but the consumer contract can deploy first and wait safely for the versioned intake fact.
