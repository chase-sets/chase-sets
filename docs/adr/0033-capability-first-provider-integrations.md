# ADR 0033: Capability-First Provider Integrations

## Status

Accepted architecture, recorded for [#6477](https://github.com/chase-sets/chase-sets/issues/6477).
This record does not ship adapters, change ownership, or require a retrofit.
Current examples below were inspected at `021729a4a3d4b930ff3dc5b0d04c055bfc64a167`.
Prescribed behavior and later convergence are distinguished from executable behavior.

## Context And Authorities

Capabilities, not vendors, organize provider integrations. Bounded contexts own
behavior and consuming contract language; infrastructure translates external APIs;
deployables compose implementations. A vendor can serve several capabilities
without becoming a business ownership boundary.

The governing constraints include these verbatim quotations:

- [#4322](https://github.com/chase-sets/chase-sets/issues/4322): "Provider ports, not provider tables".
- [#4383](https://github.com/chase-sets/chase-sets/issues/4383): "nothing eBay-specific may leak into the port contract".
  This historical quotation is preserved from the original accepted
  [#6477 brief](https://github.com/chase-sets/chase-sets/issues/6477), not from
  #4383's current replacement-tracking body, which no longer contains it.
- [#4384](https://github.com/chase-sets/chase-sets/issues/4384): "it IS the port over HTTP/MCP".

This ADR composes, rather than replaces, these prior decisions:

- [ADR 0007](./0007-google-shopping-merchant-center-integration.md): Discovery owns
  the Google Shopping export projection; other contexts retain their source facts.
- [ADR 0012](./0012-unified-outbound-messaging.md): contexts own message intent;
  shared outbound messaging contracts and infrastructure own delivery mechanics.
- [ADR 0014](./0014-stripe-connect-accounts-api-boundary.md): Stripe Accounts v1/v2
  selection stays inside the money-movement adapter, not its consuming contract.
- [ADR 0015](./0015-deployables-as-runtime-composition-roots.md): deployables are
  composition roots, not behavior owners. Its superseded compute-runtime choice
  is not revived here.

Reuse the [cross-context adaptation rules](../GLOSSARY.md#adaptation-rules) and
[Channels glossary](../../bounded-contexts/channels/GLOSSARY.md); no new terms are introduced.

## Decision

### 1. Capability Ports

Use one provider-neutral port per capability, owned by the consuming bounded
context's contract surface. Provider-specific API shapes and policy must not leak
into it. Cross-context published ports live in `contracts/`, not a deployable.

Current examples are `PostageLabelProvider` in
[postage-labels](../../contracts/postage-labels/index.ts), `PaymentProcessorGateway`
in [payment-processing](../../contracts/payment-processing/index.ts), and
`MoneyMovementGateway` in [money-movement](../../contracts/money-movement/index.ts).
These demonstrate the capability axis, not universal completion of neutrality:
the explicit single-processor exception is recorded in rule 8.

### 2. Provider-Capability Adapters

Use one adapter per `(provider, capability)`, named
`infrastructure/<vendor>-<capability>`. Use raw `fetch` with an injectable `fetch`
option, not vendor SDKs. The standing SDK exception is
`@aws-sdk/client-sesv2` in [ses-email](../../infrastructure/ses-email/package.json).
Preserve [R51/R52](../architecture/bounded-context-structure.md): contracts remain
runtime-neutral; infrastructure must not depend on bounded contexts, deployables,
or shared `packages/`.

Current [easypost-postage](../../infrastructure/easypost-postage/index.ts) exposes
the injectable option. [stripe-payments](../../infrastructure/stripe-payments/index.ts)
and [stripe-connect](../../infrastructure/stripe-connect/index.ts) use raw global
`fetch` today; injection is the target, not a claim about those factories.
This ADR changes neither implementation nor the standing SES exception.

### 3. Placement And Runtime Boundaries

Put external API transport/translation in `infrastructure/`, behind a contracts
port supplied through the consuming context's `hostPorts`. Current declarations
include [Fulfillment](../../bounded-contexts/fulfillment/context.json),
[Payments](../../bounded-contexts/payments/context.json), and
[Settlement](../../bounded-contexts/settlement/context.json).

Use an in-context registry instead when domain mapping profiles and in-context
governance dominate, as in Catalog's
[ProviderAdapterRegistry](../../bounded-contexts/catalog/features/source-observations/api/provider-adapters/registry.ts).
This is a domain-governed alternative, not permission to house generic transport
in a deployable. In either shape, consumer/domain runtime code has no provider
branches; select implementations in composition or the registry. Provider-specific
translation and internal strategy selection belong inside the adapter, including
ADR 0014's Accounts API strategy.

Current Merchant [client](../../deployables/platform-worker/src/google-merchant-client.ts)
and [auth](../../deployables/platform-worker/src/google-merchant-auth.ts) remain in
`platform-worker`. This tolerated placement is corrective work owned by
[#3489](https://github.com/chase-sets/chase-sets/issues/3489), not the preferred
rule and not evidence of a shipped infrastructure extraction. ADR 0007's
Discovery ownership and deployable scheduling/composition remain intact.

### 4. Sub-Capabilities

Represent sub-capabilities as flags on the provider descriptor, not a new port
for every operation. Catalog's
[ProviderAdapterCapabilities](../../bounded-contexts/catalog/features/source-observations/api/provider-adapters/provider-adapter.ts)
currently declares `supportsOptionQueries`, `supportsImportPlanning`, and
`supportsPayloadFetch`.

Split a capability into a separate port only when a different bounded context
consumes it: Payments' payment processing and Settlement's money movement explain
the separate `stripe-payments` and `stripe-connect` adapters. Do not add speculative
ports for an imagined provider or consumer.

### 5. Vendor-Shared Plumbing

Extract `<vendor>-core` or `<vendor>-config` when the vendor gains its second
capability package, never preemptively. Share technical plumbing, not domain
policy or an omnibus vendor gateway.

Current [stripe-config](../../infrastructure/stripe-config/index.ts) shares the
API-version pin and webhook event registry. Both Stripe adapters still duplicate
HTTP/form, authentication, and signature/envelope helpers. This is accepted-then-repaid
cost, not completed deduplication. [#3991](https://github.com/chase-sets/chase-sets/issues/3991)
tracks the hardening program; [#6481](https://github.com/chase-sets/chase-sets/issues/6481)
owns the narrower executable-helper extraction. Keep the data-only config helper
distinct from that intended core; no new package is created here.

### 6. Context-Owned Webhooks

The consuming context exports path constants and owns ingestion and its inbox
tables. The provider adapter verifies signatures and translates payloads; the
shared [provider-webhook-inbox](../../infrastructure/provider-webhook-inbox/index.ts)
helper takes the context's table name. Do not introduce a central webhook router.

Current Payments exports its
[provider path](../../bounded-contexts/payments/features/payments/api/provider-webhook-paths.ts)
and uses the helper in its
[webhook transaction](../../bounded-contexts/payments/features/payments/api/webhook-transaction.ts).
Signature verification remains in the Stripe adapters. Deployables mount the
context-owned routes. [#6480](https://github.com/chase-sets/chase-sets/issues/6480)
owns broader ingestion telemetry, not a new routing owner or work delivered here.

### 7. Credentials And Connections

Read platform-level provider credentials from the environment only at the
deployable composition boundary, using config-schema loaders, discriminated-union
provider configs, and go-live guardrails. Pass configuration into adapters, not
environment access into ports or domain behavior. Current
[platform-api config](../../deployables/platform-api/src/config.ts) composes
`loadStripeProviderConfig` from shared
[config-schema](../../infrastructure/platform-runtime/config-schema.ts).

Per-seller connections are context-owned durable state, not platform environment
configuration. [Todd's #6478 Option 1 resolution](https://github.com/chase-sets/chase-sets/issues/6478#issuecomment-5170326918)
assigns the complete marketplace-channel connection, credential/refresh,
authorization, webhook subscription, and health lifecycle to Channels. Identity
retains account-level capabilities and standing. Agent-platform OAuth is outside
that ruling. The [Channels glossary](../../bounded-contexts/channels/GLOSSARY.md)
records this language; ownership does not assert that every provider connection
is implemented. [provider-credentials](../../contracts/provider-credentials/index.ts)
already supplies shared readiness vocabulary, not a new connection owner.

### 8. Single-Processor Exception

Current [payment-processing](../../contracts/payment-processing/index.ts) declares
`PaymentProcessorName = "stripe"`. Tolerate this explicit pin while there is one
processor; opening it to a provider-neutral boundary is the admission price for
processor #2. Do not widen it speculatively or treat the exception as permission
for other vendor-specific port leakage. This record makes no contract edit.

### 9. Seller-Owned BYO Channels

Seller-owned Shopify-class channels use the published BYO contract prescribed
by [#4384](https://github.com/chase-sets/chase-sets/issues/4384), not first-party
adapters for each storefront. The same provider-neutral port is exposed over
HTTP/MCP; it is not a second vendor-specific domain model. First-party marketplace
providers remain a distinct integration posture.

This is the prescribed BYO boundary, not a claim that the published transport,
certification, reference adapter, or portal documentation ships today. Their
implementation belongs to #4384's program. This ADR implements none of them.

## Alternatives And Consequences

- Vendor-first ports or provider tables make every consumer carry vendor policy;
  capability ports keep consumer ownership stable when a provider changes.
- A universal vendor gateway or preemptive core hides unrelated capabilities and
  adds abstractions before a second real consumer. Delayed extraction accepts
  bounded duplication until the second capability justifies repayment.
- Infrastructure-only placement would erase Catalog's domain-governed registry;
  deployable-owned transport would invert the composition boundary. Placement
  follows the responsibility, not a blanket folder rule.
- One port per sub-operation creates needless contracts; descriptor flags keep
  related behavior together, while different context consumers justify a split.
- A central webhook router or platform credential owner would move lifecycle
  authority away from the context. Shared technical helpers do not own that policy.

Converge lazily, highest-traffic first, through separately owned corrective slices.
Do not retrofit existing integrations as an acceptance condition of this ADR.
No runtime code, contracts, schemas, manifests, UI, tests, provider access,
glossary terms, new verifier, provider approval, or ownership decision changes.
