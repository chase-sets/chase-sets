# UCP AI Commerce Adoption

## Intent

Review and recommend how Chase Sets should adopt the Universal Commerce Protocol (UCP) so custom AI agents can discover products, create/update checkout sessions, complete commerce through trusted user confirmation, and read order state without bypassing marketplace-owned domain rules.

Primary recommendation: adopt UCP as an external protocol facade over existing bounded-context behavior, not as a new domain model. UCP shapes agent interoperability; Chase Sets bounded contexts remain the source of truth for behavior, events, read models, authorization, and tests.

UCP sources reviewed:

- https://ucp.dev/
- https://github.com/Universal-Commerce-Protocol/ucp
- https://ucp.dev/latest/specification/checkout/
- https://ucp.dev/latest/specification/checkout-rest/
- https://ucp.dev/latest/specification/checkout-mcp/
- https://ucp.dev/latest/specification/cart-rest/
- https://ucp.dev/latest/specification/catalog/
- https://ucp.dev/latest/specification/catalog/lookup/
- https://ucp.dev/latest/specification/order-rest/
- https://ucp.dev/specification/identity-linking/
- https://ucp.dev/latest/specification/payment-handler-guide/

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-ai-commerce`
- Branch: `codex/ucp-ai-commerce`
- Base: current source checkout HEAD `8cc4f1e6` (`main`, behind `origin/main` by 43 at worktree creation)
- Dependency setup: `pnpm run deps:install` succeeded.
- Sandbox doctor: `pnpm run sandbox:doctor` succeeded.
- Sandbox id: `8b6eb56e`
- Port base: `7700`
- Platform API: `http://localhost:7712`
- Marketplace web: `http://localhost:7703`
- Setup caveats: dependency install reported existing cyclic workspace dependencies among checkout, ordering, marketplace seed testing, and discovery; not caused by this plan.

## Owning Contexts

Recommended ownership:

- Auth: OAuth/identity-linking journey entry points, session resolution, bearer token actor resolution, account selection, safe return paths.
- Identity: UCP-linked platform/client registrations if they represent external software principals, user/account consents, API-key-adjacent credential lifecycle, token revocation audit facts if durable identity behavior is needed.
- Discovery: UCP catalog search and public product detail/lookup facade for buyer-visible browse/read behavior.
- Catalog: canonical Catalog Item, Product, Dimension, Option mapping used by Discovery and Checkout. Do not expose Catalog authoring internals as UCP products.
- Marketplace: Listing and Offer facts that shape available variants, prices, public demand, and seller listing availability.
- Checkout: UCP cart and checkout session lifecycle, source intent, shipping selection, trusted checkout handoff, order/payment orchestration.
- Ordering: UCP order management read facade after commercial commitment exists.
- Payments: UCP payment handlers, AP2-compatible payment instrument processing, buyer-side fee/payment snapshots, capture/refund state.
- Fulfillment: fulfillment/shipment state used by order reads.
- Tax: provider-agnostic tax quotes consumed by Checkout/Ordering; do not let UCP own tax policy.
- Commercial Terms: seller-side fee policy remains internal; UCP should expose buyer-visible prices/totals and only seller terms where seller-agent workflows later require it.
- Contracts/Infrastructure: UCP protocol DTOs, signature verification primitives, shared UCP IDs, OpenAPI/OpenRPC schemas, and generic HTTP signature infrastructure. Domain-specific mapping stays in owning contexts.
- Deployables: thin composition only. They mount `/.well-known/ucp`, OAuth metadata routes, `/ucp/v1`, and `/ucp/mcp`; they do not own protocol decisions.

Do not create a generic `ai-commerce`, `ucp`, or `agent-commerce` bounded context. That would centralize behavior currently and correctly owned by context boundaries.

## Resolved Decisions

### 1. Adopt UCP as an adapter layer, not a replacement domain model.

Why it matters: UCP names `Product`, `Variant`, `Cart`, `Checkout`, and `Order`, but Chase Sets already has sharper ubiquitous language: Catalog Item/Product, Listing/Offer, Cart/Checkout Session, Order/Purchase/Sale, Payment, Shipment.

Repo evidence:

- `bounded-contexts/README.md` fixes ownership for Listing, Offer, Cart, Checkout Session, Order, Shipment, Payment, and Account.
- `docs/GLOSSARY.md` says Cart is Checkout-owned, Listing and Offer are Marketplace-owned, Order is Ordering-owned, and Buyer/Seller are transaction roles.
- `bounded-contexts/catalog/README.md` defines `product_id` as derived from `catalog_item_id` plus selected options.

Recommendation:

- Use UCP DTO names only at the protocol boundary.
- Map UCP `product` to Discovery presentation over Catalog product truth.
- Map UCP `variant` to a resolved Chase Sets Product plus market availability/price signals, not to a separate durable aggregate.
- Map UCP `checkout` to Checkout Session.
- Map UCP `order` to Ordering Order/Purchase/Sale projections.

Consequence of choosing differently: UCP terms would duplicate source-of-truth concepts, increase replay and projection ambiguity, and eventually force cross-context writes from an integration layer.

### 2. Ship REST and UCP MCP in v1, sharing protocol contracts and context-owned handlers.

Why it matters: UCP supports both REST and MCP discovery through the same business profile, and custom AI agents may prefer MCP tool invocation over REST endpoint orchestration. The repo already has an MCP descriptor/bridge at `contracts/mcp` and `infrastructure/platform-runtime/mcp.ts`, so v1 can support both transports if they share one protocol contract and both call the same context-owned application services.

Repo evidence:

- `contracts/mcp/README.md` already covers agent-facing tools, permission boundaries, confirmation, idempotency keys, and `/mcp` JSON-RPC runtime behavior.
- `contracts/mcp/index.ts` defines service descriptors for Discovery, Checkout, Ordering, Payments, Fulfillment, Marketplace, and Identity.
- UCP checkout MCP maps capabilities 1:1 to tools such as `create_checkout`, `get_checkout`, `update_checkout`, `complete_checkout`, and `cancel_checkout`.

Decision:

- V1 advertises both REST and UCP MCP.
- `/.well-known/ucp` advertises `rest` endpoint `/ucp/v1` and `mcp` endpoint `/ucp/mcp` only for capabilities implemented and tested in both transports.
- REST routes and UCP MCP tools share DTOs, validation, authorization, idempotency, signature verification, audit, and conformance fixtures.
- Keep existing `/mcp` service catalog for Chase Sets-native agent tooling; add `/ucp/mcp` as the standards-facing surface with UCP tool names and UCP message envelopes.

Consequence of choosing differently: REST-only v1 would reduce surface area, but it would delay first-class custom-agent interoperability for agent hosts that discover and invoke UCP capabilities as MCP tools.

### 3. Require trusted UI handoff for order placement in v1.

Why it matters: UCP says checkout must be finalized manually through trusted UI unless AP2 Mandates are supported. Chase Sets payment and checkout flows already distinguish purchase intent, checkout confirmation, and payment creation.

Repo evidence:

- Checkout owns checkout sessions and orchestration into Ordering and Payments.
- Checkout UI already has confirmation states, shipping address collection, fulfillment preview, and payment handoff.
- Payments owns external money movement and payment processor references.

Recommendation:

- Let agents create/update checkout sessions and receive a `continue_url`.
- Do not allow headless `complete_checkout` to create orders/payment in v1 unless the request carries a supported AP2 mandate and a payment handler the platform can verify.
- For v1 `complete_checkout`, return a UCP outcome that requires trusted UI escalation when no AP2 mandate is present.
- Preserve Checkout-owned source intent and idempotency rules.

Consequence of choosing differently: headless order placement could bypass buyer review, payment-handler trust, fee/tax/shipping snapshots, or authorization consent.

### 4. Treat identity linking as OAuth-capability work, not API-key reuse.

Why it matters: UCP identity linking uses OAuth 2.0 authorization code flow, bearer tokens, revocation, and well-known authorization server metadata. Chase Sets has sessions and API keys, but API keys are not user consent tokens.

Repo evidence:

- Auth owns sessions, account selection, actor resolution, and safe return paths.
- Identity owns API keys and consents.
- Existing API security in `docs/api/marketplace.openapi.json` supports session cookies and API key bearer auth, but not UCP OAuth metadata/scopes.

Recommendation:

- Add OAuth authorization server metadata under Auth/Identity composition.
- Add UCP scope mapping to existing permission identifiers.
- Model linked platform authorization as explicit user/account consent, with revocation and audit.
- Keep API keys for software credentials and OAuth tokens for delegated platform/user authorization.

Consequence of choosing differently: API keys would blur system integration, user delegation, account selection, and revocation semantics.

### 5. Preserve low-value card economics by not overfitting UCP checkout to seller-specific line selection too early.

Why it matters: Chase Sets wants better margins for low-value cards. The current Ordering invariant says checkout lines express buyer intent and concrete listing/inventory matching happens when Ordering creates orders, while Marketplace owns listing/offer lifecycle.

Repo evidence:

- Ordering README says checkout lines are product-scoped commitments and seller grouping occurs after confirmation.
- Marketplace README says Listings and Offers target Products and Marketplace exposes available sell quantity without owning inventory truth.
- Discovery projects market listings and offer demand without owning transactions.

Recommendation:

- UCP catalog/search exposes product-level availability and representative seller/price signals.
- UCP checkout supports product-scoped lines with optional locked listing references when the agent selected a specific listing.
- Default to optimized fulfillment/order split for low-value cards to preserve batching/margin opportunities.
- Only add seller-specific UCP extensions after measuring agent behavior and fulfillment economics.

Consequence of choosing differently: early seller-locking could fragment orders, reduce batchability, and increase shipping/handling cost for low-value cards.

## Implementation Checklist

### Phase 0: Protocol Contract And ADR

- Add ADR recommending UCP REST and MCP adoption with existing bounded contexts as behavior owners.
- Add `contracts/ucp` package for protocol constants, capability names, UCP envelope/message types, transport-neutral DTOs, and conformance fixtures.
- Add UCP version pinning. Current public spec examples use `2026-04-08`; keep the version explicit and easy to upgrade.
- Add structure tests that prevent `deployables/*` from owning UCP behavior beyond route composition.

### Phase 1: Discovery Profile And Public Metadata

- Add `/.well-known/ucp` from a thin deployable route that composes context-owned capability declarations.
- Add `/.well-known/oauth-authorization-server` once identity linking is enabled.
- Advertise only supported capabilities; start with catalog lookup/search and checkout create/get/update/cancel in both REST and MCP. Add order read after order projection mapping is ready in both transports.
- Publish REST endpoint `/ucp/v1`.
- Publish UCP MCP endpoint `/ucp/mcp`.
- Publish schemas/OpenAPI/OpenRPC as generated/checked artifacts, not hand-maintained drift.

### Phase 2: Catalog Search And Lookup

- Discovery owns `POST /ucp/v1/catalog/search`, `POST /ucp/v1/catalog/lookup`, and `POST /ucp/v1/catalog/product` adapters.
- Map Catalog Item/Product/selected options into UCP Product/Variant.
- Include Marketplace listing availability, seller listing availability, offer-demand visibility, price, and stock signals only through Discovery read models.
- Preserve Catalog product identity fields in UCP extension metadata so selected options can round-trip into checkout.
- Reject ambiguous product identifiers with UCP messages instead of guessing.

### Phase 3: Cart And Checkout

- Checkout owns UCP cart and checkout session adapters.
- Map UCP cart operations to Checkout Cart when the buyer is account-linked; for guest/agent-authenticated flows, use explicit guest checkout/source-intent behavior rather than inventing an account.
- Map UCP checkout create/update to Checkout Session source intent, shipping address, selected shipping option, fulfillment preview, and payment handler readiness.
- Add UCP idempotency keys to Checkout command metadata and tests.
- Return `continue_url` for trusted UI handoff.
- Make `complete_checkout` v1 require UI escalation unless AP2 mandate support is explicitly added.

### Phase 4: Identity Linking

- Auth owns OAuth authorization, account selection, and return path.
- Identity owns durable linked platform/client consent and revocation facts.
- Define UCP scopes and map them to existing permissions:
  - `dev.ucp.shopping.catalog:read` -> public or `catalog.view` depending on visibility.
  - `dev.ucp.shopping.cart:write` -> `orders.manage`.
  - `dev.ucp.shopping.checkout:write` -> `orders.manage`.
  - `dev.ucp.shopping.order:read` -> `orders.view`.
- Support token revocation and linked-account audit trails.
- Do not reuse Identity API keys as user-delegated OAuth tokens.

### Phase 5: Order Management

- Ordering owns UCP order read.
- Compose buyer-facing Purchase and seller-facing Sale language carefully; UCP boundary may call it Order, but internal routes/projections must remain precise.
- Include Payments payment status and Fulfillment shipment state only via published facts/projections.
- Avoid post-purchase mutation through UCP until cancellation/support policies are explicitly modeled.

### Phase 6: Payment Handlers And AP2

- Payments owns UCP payment handler declaration and instrument validation.
- Start with redirect/trusted UI or processor tokenization that keeps Chase Sets out of raw card handling.
- Add AP2 Mandates only after a durable mandate verification model exists.
- Keep payment handler config in Payments, with deployables supplying environment/provider wiring only.

### Phase 7: MCP Compatibility

- Add UCP MCP endpoint `/ucp/mcp`.
- Reuse `contracts/mcp` authorization, confirmation, idempotency, audit, and handler registration concepts.
- Add UCP tool descriptors/names as a standards-facing profile, not replacements for Chase Sets-native MCP service descriptors.
- Keep REST and MCP behavior contract-locked: each UCP operation must have equivalent authorization, validation, idempotency, replay, domain handoff, and outcome semantics across both transports.
- Verify MCP Streamable HTTP, HTTP signatures, and UCP-specific tool naming.

### Phase 8: Operations, Observability, And Abuse Controls

- Add HTTP Message Signatures verification and response signing in infrastructure.
- Add replay protection keyed by `Idempotency-Key`, signature digest, actor/platform, operation, and target id.
- Add audit events for profile discovery, identity linking, checkout mutation, complete attempts, and order reads.
- Add rate limits per platform/client, agent profile, account, and IP.
- Redact addresses, emails, payment credentials, tokens, and signature secrets in logs.
- Add conformance fixtures from UCP schemas and sample requests.

## Stress Tests

- Normal flow: agent searches product, looks up exact product/variant, creates checkout, adds shipping, receives trusted `continue_url`, buyer confirms, orders and payment are created by existing Checkout/Ordering/Payments behavior.
- Partial flow: agent creates checkout without payment or full shipping; Checkout returns messages and required fields without committing orders.
- Multi-seller flow: product-scoped checkout splits into multiple seller orders only after confirmation; UCP response does not promise one seller/order before Ordering owns that decision.
- Stale data: agent starts checkout from a stale catalog price; Checkout/Ordering refreshes seller availability, fee/tax/shipping snapshots, and returns UCP messages or UI escalation.
- Replay: duplicate `complete_checkout` with same idempotency key returns same safe outcome; duplicate with different key cannot double-create orders/payment.
- Cross-context handoff: Marketplace publishes listing/offer facts; Discovery projects them; Checkout consumes selected product/listing intent; Ordering commits; Payments captures; Fulfillment ships. Each handoff uses stable facts, not commands.
- Failure/cancellation: payment failure leaves Checkout/Payments state recoverable; order cancellation follows Ordering/Fulfillment cutoff; refund belongs to Payments.
- Low-value card economics: optimized fulfillment can batch cheap cards; locked-listing checkout is available only when the agent/user intentionally chooses a seller/listing.
- Identity mismatch: OAuth token for one account cannot mutate another account's cart/checkout, even when agent context includes product URLs for both.
- Privacy: public catalog search and lookup never expose buyer identity, private seller operational notes, shipping destinations, or payment details.

## Documentation To Promote

- `docs/adr/<next>-adopt-ucp-for-agent-commerce.md`: REST and MCP UCP adoption, bounded-context ownership, trusted UI default, OAuth identity linking, and AP2 deferral.
- `docs/architecture/ucp-agent-commerce.md`: protocol facade, route ownership, signature/idempotency flow, deployment surfaces, and context map.
- `docs/api/ucp.openapi.json`: generated/checked REST contract.
- `docs/runbooks/ucp-agent-commerce.md`: onboarding a platform, key rotation, revocation, incident response, replay handling, and conformance checks.
- `docs/GLOSSARY.md`: add cross-context index entries for UCP Profile, UCP Capability, Linked Platform Authorization, Payment Handler, AP2 Mandate only after local owning glossary terms are added.
- Context glossaries:
  - Auth: OAuth Authorization, Linked Platform Session if needed.
  - Identity: Linked Platform Authorization, Platform Client, OAuth Consent.
  - Checkout: Trusted Checkout Handoff, UCP Checkout Session Adapter.
  - Payments: Payment Handler, AP2 Mandate.

## Open Questions

None currently blocking this recommendation pass.

Resolved transport decision: v1 should advertise both REST and UCP MCP, with both transports limited to the same implemented capability set and backed by the same context-owned behavior.

## Implementation Progress

- Added `contracts/ucp` with the pinned UCP version, profile/capability declarations, UCP envelopes, MCP tool names, package tests, and README.
- Added `infrastructure/platform-runtime/ucp.ts` and tests for `/.well-known/ucp`, `/ucp/v1`, `/ucp/mcp`, signed checkout writes, `Content-Digest`, cryptographic HTTP Message Signature verification through a UCP key resolver, MCP argument passing, and idempotency/replay conflict behavior.
- Added Discovery-owned UCP catalog search/lookup/product handlers in `bounded-contexts/discovery/support/ucp-support/catalog.ts` with focused tests.
- Added Checkout-owned UCP checkout handlers in `bounded-contexts/checkout/support/ucp-support/checkout.ts` with focused tests. Checkout create/get/update call existing Checkout Session services; complete returns trusted UI escalation unless the session is already completed; cancel remains an explicit requires-action outcome because Checkout Session cancellation is not modeled by the aggregate yet.
- Mounted UCP profile, REST, and MCP routes in `deployables/platform-api/src/app.ts`. Platform API only composes context-owned handlers and applies actor context to `/ucp/v1/*` and `/ucp/mcp`.
- Added ADR, architecture, runbook, OpenAPI skeleton, docs index entries, and glossary updates across Auth, Identity, Checkout, Payments, and the cross-context glossary.

## Verification Evidence

- `pnpm --filter @chase-sets/ucp run test`
- `pnpm --filter @chase-sets/ucp run typecheck`
- `pnpm --filter @chase-sets/platform-runtime run test -- ucp.test.ts`
- `pnpm --filter @chase-sets/platform-runtime run typecheck`
- `pnpm --filter @chase-sets/checkout run test -- tests/ucp-checkout.test.ts`
- `pnpm --filter @chase-sets/discovery run test -- tests/ucp-catalog.test.ts`
- `pnpm --filter @chase-sets/app-platform-api run test -- app.test.ts`
- `pnpm --filter @chase-sets/app-platform-api run typecheck`
- `pnpm run sync:workspace-metadata`
- `pnpm run check:structure`
- `pnpm run check:no-any`
- `pnpm run typecheck`
- `pnpm run verify:static`

Historical verification note: root `pnpm run typecheck` timed out twice earlier in the implementation pass, then completed successfully after the later UCP runtime and docs updates.

## Remaining Gaps

- HTTP Message Signature request verification is implemented behind a runtime key resolver. Production still needs a durable UCP profile/key cache and response signing for high-risk responses.
- Idempotency/replay protection currently has a runtime store interface plus in-memory default. A durable store should be wired before production rollout.
- OAuth authorization server metadata, token issuance/revocation, and durable Linked Platform Authorization are planned and documented but not implemented.
- UCP order read, cart operations beyond checkout-session creation/update, payment handler declarations, and AP2 mandate verification are deferred.
- OpenAPI is currently a checked skeleton, not generated from executable schema.
- No UI changes were made, so no visual handoff screenshots were required in this pass.
- PR creation, CI, merge, and staging verification remain outstanding.

## Goal Completion Criteria

A later implementation goal should complete only after:

- Feature worktree remains `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-ai-commerce` on `codex/ucp-ai-commerce`.
- Product code implements the settled UCP phase scope without moving behavior into deployables.
- Durable docs above are promoted or consciously deferred in the PR.
- Context glossaries and `docs/GLOSSARY.md` are updated for any new public terms.
- Automated checks cover protocol DTOs, context adapters, auth/scope enforcement, signatures, idempotency, replay, stale state, and route composition.
- Mobile and desktop visual checks cover trusted checkout handoff surfaces if UI changes are included.
- UCP conformance fixtures cover profile discovery, catalog lookup/search, checkout create/update/get/cancel, UI escalation for complete, and order read when included.
- PR is submitted, CI passes, PR merges, staging deploy is verified against `/.well-known/ucp` and `/ucp/v1`.
- This plan file remains committed with the implementation for review history.
