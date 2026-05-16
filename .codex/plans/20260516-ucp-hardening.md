# UCP Hardening Plan

Date: 2026-05-16
Worktree: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-hardening`
Branch: `codex/ucp-hardening`
Base: `origin/main` at `aaffee12820702fd2a198d94f2aafd81ed9dcdd3`

## Intent

Harden the Universal Commerce Protocol implementation so custom AI agents can move from discovery and trusted checkout handoff toward production-grade commerce through the marketplace platform.

Known next hardening items:

- Durable UCP idempotency storage.
- Production agent key/profile cache.
- OAuth token and linked platform authorization runtime.
- AP2 mandate/payment-handler handoff.
- Standalone order reads.

## Setup Evidence

- Created a dedicated feature worktree from current `origin/main`.
- Ran `pnpm run deps:install` successfully using shared store `D:\Users\ToddS\Source\Repos\.chase-sets-pnpm-store`.
- Ran `pnpm run sandbox:doctor` successfully.
- Sandbox id: `925beaa5`.
- Platform API local URL: `http://localhost:10262`.
- Setup caveat: existing cyclic workspace dependency warning among `checkout`, `ordering`, `marketplace-seed-testing`, and `discovery`; no setup failure.

## Context Ownership

- `contracts/ucp`: wire-level protocol constants, payload schemas, capabilities, and tool names. No business ownership.
- `infrastructure/platform-runtime`: UCP transport/profile/signature/idempotency runtime, cache adapters, and route composition support.
- `bounded-contexts/auth`: OAuth authorization journey, account selection, token-facing actor resolution, and safe return paths.
- `bounded-contexts/identity`: durable linked platform authorization consent/client reference/revocation/audit facts.
- `bounded-contexts/checkout`: cart and checkout session lifecycle, UCP checkout adapters, trusted checkout handoff.
- `bounded-contexts/payments`: payment handlers, payment intent orchestration, AP2 mandate verification model.
- `bounded-contexts/ordering`: committed order state and buyer/seller order read models.
- `deployables/platform-api`: thin composition root that wires UCP routes and context handlers.

## Repo Evidence

- `docs/architecture/ucp-agent-commerce.md` explicitly keeps UCP as a protocol facade and assigns concrete behavior to bounded contexts.
- `docs/runbooks/ucp-agent-commerce.md` documents the current runtime guardrails and remaining production readiness gates.
- `.codex/plans/20260516-ucp-ai-commerce.md` lists the same hardening gaps: durable replay storage, production profile/key cache, OAuth/linking, AP2/payment handlers, and order reads.
- `infrastructure/platform-runtime/ucp.ts` currently exposes `UcpIdempotencyStore`, `UcpSignatureKeyResolver`, in-memory idempotency defaults, digest checks, HTTP Message Signature verification hooks, and idempotency scoping.
- No durable UCP idempotency store or production profile/key cache implementation exists yet.
- Auth owns OAuth authorization language, but no OAuth authorization server metadata, token issue, token revoke, or UCP linking routes exist yet.
- Identity owns Linked Platform Authorization language, but no UCP OAuth-linked durable authorization runtime exists yet.
- Checkout UCP `complete_checkout` currently returns `trusted_checkout_handoff` and does not do headless AP2 payment completion.
- Payments contains payment session/payment intent runtime and AP2/payment-handler glossary terms, but no UCP AP2 mandate verification/payment-handler runtime exists yet.
- Ordering has purchase/sale read models and routes, but UCP currently has no standalone order read contract/tool/handler.

## Proposed Implementation Shape

1. Add infrastructure-owned durable UCP replay/idempotency storage.
   - Keep the runtime interface stable.
   - Add a production Postgres-backed adapter and wire it through `platform-api`.
   - Preserve the in-memory adapter for tests and local isolated use.
   - Scope by agent profile, actor, operation, target, and idempotency key.

2. Add infrastructure-owned production UCP profile/key cache.
   - Resolve and cache public agent profiles/keys for HTTP Message Signature verification.
   - Include TTL, rotation tolerance, failure telemetry, and deterministic test hooks.
   - Keep profile/key mechanics outside bounded contexts unless a domain fact is required.

3. Add Auth and Identity UCP OAuth/linking runtime.
   - Auth owns OAuth metadata, authorization, token, refresh/revoke, and actor resolution surfaces.
   - Identity owns durable Linked Platform Authorization facts, scopes, account bindings, revocation, and audit.
   - Token scopes should map to UCP capabilities and context permissions using natural marketplace language.

4. Add Payments-owned AP2 mandate/payment-handler handoff.
   - Payments owns accepted payment-handler declarations and AP2 mandate verification decisions.
   - Checkout continues to own checkout session state and completion orchestration.
   - The implementation boundary depends on the open decision below.

5. Add Ordering-owned standalone UCP order reads.
   - Extend UCP contracts with order read capabilities/tools.
   - Add Ordering UCP adapters over existing purchase/sale read models.
   - Enforce actor/account access through the same request actor and linked authorization model.

6. Update docs, ADR/runbook readiness gates, and smoke/contract tests.
   - Keep deployables as thin composition roots.
   - Add tests at contract/runtime/context boundaries where behavior lives.
   - Extend staging smoke coverage only for production-ready behavior.

## Pressure Test

- UCP must not become a new bounded context. It remains a facade over owned marketplace capabilities.
- Idempotency and key caching are platform infrastructure concerns; they must not leak commerce behavior.
- OAuth token/linking must not reuse API keys as a shortcut because Identity glossary distinguishes Linked Platform Authorization from API keys.
- Headless checkout completion is risky without a durable AP2/provider trust model. A safe implementation can advertise capabilities and return explicit continuation/rejection states until mandate verification is real.
- Order reads should use Ordering projections rather than re-querying Checkout or Payments facts from the protocol layer.

## Open Decision 1

Decision: define the AP2/payment-handler implementation boundary for this hardening pass.

Why it matters: `complete_checkout` either remains a trusted handoff with richer Payments-owned validation, or it starts creating orders/payments headlessly from AP2 mandates. That changes security posture, payment risk, and what must be production-grade before agents can complete purchases.

Recommended answer: guarded scaffold. Implement durable stores, OAuth/linking, order reads, payment-handler declarations, and AP2 mandate validation/rejection/continuation states now; keep headless AP2 checkout completion disabled until a real AP2 provider contract and mandate trust model are finalized.

Repo evidence: Checkout currently returns `trusted_checkout_handoff`; Payments owns AP2 mandate/payment-handler language but has no durable verification runtime; the UCP architecture doc says trusted checkout hands off to UI unless AP2 mandate support is implemented.

Consequence: choosing guarded scaffold gives production hardening for agent commerce reads/linking/replay/signatures while avoiding premature money movement. Choosing headless AP2 completion expands this pass into a payment trust model implementation.

Answer: guarded scaffold.

Implementation consequence: this pass will not create orders or payments headlessly from AP2 mandates. It will add Payments-owned payment-handler/AP2 declarations and explicit verified rejection/continuation states, while `complete_checkout` continues to use trusted UI handoff for purchase completion.

## Implementation Record

- Added `platform_ucp_idempotency_records` and `platform_ucp_agent_profiles` to the platform control-plane schema.
- Added `createPostgresUcpIdempotencyStore` and `createUcpProfileKeyResolver` in `infrastructure/platform-runtime/ucp.ts`.
- Wired production platform-api UCP composition to the control-plane idempotency store and profile/key resolver.
- Added Auth-owned OAuth metadata, authorization, token, and revoke routes under `/.well-known/oauth-authorization-server` and `/ucp/oauth/*`.
- Added Identity-owned Linked Platform Authorization storage and actor resolution for `ucp_at_*` bearer tokens.
- Added UCP scope-to-permission narrowing for linked tokens.
- Added Payments-owned payment-handler declarations and guarded AP2/payment-handler continuation responses.
- Updated Checkout UCP completion to include payment handoff metadata and preserve trusted UI completion.
- Added Ordering-owned `get_order` UCP REST/MCP handling over purchase/sale projections.
- Updated UCP capability declarations, MCP tool list, architecture docs, runbook, ADR, and context manifests.

## Verification Record

- `pnpm --filter @chase-sets/auth test` passed.
- `pnpm --filter @chase-sets/identity test` passed.
- `pnpm --filter @chase-sets/ucp test` passed.
- `pnpm --filter @chase-sets/platform-runtime typecheck` passed.
- `pnpm --filter @chase-sets/platform-runtime test` passed.
- `pnpm --filter @chase-sets/checkout test` passed.
- `pnpm --filter @chase-sets/ordering test` passed.
- `pnpm --filter @chase-sets/payments typecheck` passed.
- `pnpm --filter @chase-sets/payments test:fast` passed.
- `pnpm --filter @chase-sets/app-platform-api typecheck` passed.
- `pnpm --filter @chase-sets/app-platform-api test:fast` passed.
- `pnpm run check:structure` passed.
- `pnpm run verify:metadata` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:test` passed.

Known verification notes:

- Initial `--runInBand` attempts failed because Vitest does not support that option here; reran without it.
- Full DB-backed platform bootstrap and staging smoke remain follow-up PR/CI activities.
