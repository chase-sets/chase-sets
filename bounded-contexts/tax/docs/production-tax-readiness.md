# Production Tax Readiness

Production marketplace order creation must fail closed until Tax readiness has accountable approval and a provider-backed `TaxQuoteResolver` is composed into Ordering.

## Current State

- Tax owns provider-agnostic quote contracts and local deterministic quote behavior.
- Ordering owns immutable order tax snapshots and consumes an injected Tax-owned `taxQuoteResolver` host port.
- Local and test composition may use implicit zero-tax behavior so development remains lightweight.
- Production Platform API composes a blocker resolver until a provider-backed resolver is implemented. If an order creation path reaches Tax in production without that provider, the quote request fails before an order can store an implicit zero-tax snapshot.
- Terraform and the production deployment workflow require `PRODUCTION_TAX_READINESS_APPROVED=true` and a non-empty `PRODUCTION_TAX_READINESS_REFERENCE` before `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` can promote the public marketplace.

## Approval Evidence

`PRODUCTION_TAX_READINESS_REFERENCE` should point to durable launch evidence, such as a counsel/accounting approval record, tax provider rollout ticket, or launch review artifact. It must confirm:

- live quote provider coverage for the launch geography;
- nexus and marketplace-facilitator scope reviewed by accountable counsel/accounting owners;
- remittance and filing ownership recorded outside Ordering;
- refund and cancellation tax behavior reviewed with Payments and Ordering;
- monitoring or reconciliation ownership assigned for provider quote failures.

## Future Provider Delivery

The provider integration should stay behind the Tax quote resolver contract. Do not make Ordering import provider SDKs, nexus rules, or remittance policy. The provider delivery should replace the production blocker resolver in Platform API composition, add provider health or smoke checks, and keep order snapshots provider-neutral.

## Failure Posture

If Tax readiness evidence is missing, keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`. If production somehow reaches order creation without a provider-backed resolver, the production blocker resolver rejects the quote request so no live order is created with implicit zero tax.
