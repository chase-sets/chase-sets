# Production Tax Readiness

Production marketplace order creation must fail closed until Tax readiness has accountable approval. A provider-backed `TaxQuoteResolver` is required only when Tax nexus tracking shows one or more jurisdictions require live sales-tax collection.

## Current State

- Tax owns provider-agnostic quote contracts and local deterministic quote behavior.
- Tax owns state-by-state nexus readiness tracking so launch can distinguish no-collection posture from provider-backed collection posture.
- Ordering owns immutable order tax snapshots and consumes an injected Tax-owned `taxQuoteResolver` host port.
- Local and test composition may use implicit zero-tax behavior so development remains lightweight.
- Production Platform API composes a blocker resolver only when `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true`. If collection is required but no provider-backed resolver is composed, the quote request fails before an order can store an implicit zero-tax snapshot.
- Terraform and the production deployment workflow require `PRODUCTION_TAX_READINESS_APPROVED=true` and a non-empty `PRODUCTION_TAX_READINESS_REFERENCE` before `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true` can promote the public marketplace.
- The redacted [Marketplace Launch Evidence](../../../docs/runbooks/marketplace-launch-evidence.md) packet must encode the Tax posture as either `no_collection_required` or `provider_backed_quotes_required`, and its `productionEnvironment.TAX_PROVIDER_BACKED_QUOTES_REQUIRED` value must match that posture.

## Approval Evidence

`PRODUCTION_TAX_READINESS_REFERENCE` should point to durable launch evidence, such as a counsel/accounting approval record, tax provider rollout ticket, or launch review artifact. It must confirm:

- live quote provider coverage for each collection-required launch jurisdiction, or explicit approval that no launch jurisdiction currently requires collection;
- nexus and marketplace-facilitator scope reviewed by accountable counsel/accounting owners;
- remittance and filing ownership recorded outside Ordering;
- refund and cancellation tax behavior reviewed with Payments and Ordering;
- monitoring or reconciliation ownership assigned for provider quote failures.

For a launch posture where no jurisdiction currently requires collection, the evidence may explicitly approve `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=false` instead of requiring a live quote provider. That approval must include:

- the Tax nexus readiness report used for launch, including state-by-state sales totals, transaction counts, registration status, collection status, and manual-review jurisdictions;
- the reviewed threshold policy source or accountable owner for the conservative launch thresholds;
- the alert thresholds and owner for 80%, 95%, and 100% threshold progress;
- the rule that `TAX_PROVIDER_BACKED_QUOTES_REQUIRED` must be set to `true` before any registered or collecting jurisdiction accepts live orders;
- the provider/filing decision owner for the first collection-required jurisdiction.

Use `pnpm run marketplace:tax-nexus-measurement -- --environment production --reference TAX-NEXUS-SOURCE-2026-05-30` first to build the redacted source activity from production `ordering_order_pages` tax snapshots. The command counts US, non-cancelled checkout pipeline orders by jurisdiction for the previous and current calendar year windows, defaults registration and collection posture to not registered/not collecting, and fails closed unless the measurement is explicitly production-scoped, has an ISO `checkedAt`, names an operator, is tied to a real source measurement evidence record and projection-freshness record, has an internally consistent query window, emits every Tax-supported US jurisdiction, every order has a recognized jurisdiction, and `passesSourceMeasurementGate=true`. Counsel/accounting must still review the measurement, overlay registration and collection status, approve threshold policy, and produce the `TaxNexusReadinessReport` with the source measurement reference, production environment, query version, source measurement `checkedAt`, projection freshness reference, query window, jurisdiction count, zero missing/unknown jurisdiction counts, `sourceMeasurementRequiresManualReview=false`, `sourceMeasurementPasses=true`, and the state-by-state jurisdiction review count.

Use `pnpm run marketplace:tax-readiness-evidence` with the redacted Tax nexus readiness report and approval references to produce the `gates.taxReadiness` fields for the launch evidence packet. The command also requires separate threshold policy and nexus monitoring references so a no-provider launch carries the alert thresholds, owner, and rule for switching `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` before any registered or collecting jurisdiction accepts live orders. When provider-backed collection is required, pass `--provider-backed-resolver-composed true` and `--provider-backed-resolver-reference` pointing to the production resolver composition and smoke evidence. The command fails the gate when the report has collection-required jurisdictions without provider-backed quote readiness, when provider-backed collection is required but the production resolver has not been composed and verified with a concrete evidence reference, when the report source measurement is not production-scoped, not from the canonical query version, not tied to a passing source measurement, missing a projection freshness reference, has missing or unknown jurisdiction coverage, omits the Tax-supported jurisdiction state-by-state review count, when the report `asOf` timestamp is invalid, in the future, or older than 30 days, or when threshold policy / monitoring evidence is missing. Refresh the state-by-state nexus review before final launch approval if the report ages out.

## Future Provider Delivery

The provider integration should stay behind the Tax quote resolver contract. Do not make Ordering import provider SDKs, nexus rules, or remittance policy. The provider delivery should replace the production blocker resolver in Platform API composition when `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true`, add provider health or smoke checks, and keep order snapshots provider-neutral.

## Failure Posture

If Tax readiness evidence is missing, keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`. If Tax nexus tracking shows collection is required, set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` until a provider-backed resolver is composed and verified. If production somehow reaches order creation with that flag enabled and no provider-backed resolver, the production blocker resolver rejects the quote request so no live order is created with implicit zero tax.
