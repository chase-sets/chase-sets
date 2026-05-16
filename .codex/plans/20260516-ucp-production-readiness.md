# UCP Production Readiness Hardening

Date: 2026-05-16

Worktree: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-production-readiness`

Branch: `codex/ucp-production-readiness`

Base: `origin/main` at `55f4c405 Harden UCP agent commerce runtime (#130)`

Sandbox: `fca34583`; Platform API `http://localhost:10962`

## Request

Plan and build as much of the remaining Universal Commerce Protocol production-readiness work as possible into the current system, using the Chase Sets bounded-context model and keeping UCP as a standards-facing facade rather than a new bounded context.

## Current Baseline

The merged UCP baseline already provides the public profile, REST and MCP transports, catalog/search, checkout session operations, standalone order reads, durable idempotency storage, profile/key cache, OAuth authorization-code/token/revoke basics, bearer-token actor resolution, AP2-safe trusted checkout handoff, payment-handler declarations, runbook, and ADR.

Official UCP references checked during this pass:

- UCP order REST requires HTTPS/TLS 1.3 in production, `UCP-Agent` on requests, authenticated order reads, and recommends business response signing.
- UCP identity linking uses OAuth 2.0 Authorization Code flow with PKCE.
- UCP checkout/payment-handler/AP2 material keeps AP2 autonomous checkout bound to cryptographic mandates and verified checkout/payment terms.

## Owning Contexts

- `contracts/ucp`: UCP constants, profile declaration, envelopes, MCP tool metadata.
- `infrastructure/platform-runtime/ucp`: REST/MCP route plumbing, signed write checks, HTTP Message Signature verification, profile/key cache, durable replay/idempotency store, operational observer hooks.
- `auth/support/ucp-support`: Auth-owned OAuth journey and token endpoints for UCP identity linking.
- `identity/support/ucp-support`: Identity-owned durable Linked Platform Authorization consent, token hashes, revocation, refresh rotation, and account/user consent reads.
- `payments/support/ucp-support`: Payments-owned payment-handler declaration and AP2 mandate acceptance/rejection policy.
- `checkout/support/ucp-support`: Checkout-owned trusted checkout handoff and checkout session lifecycle adapters.
- `ordering/support/ucp-support`: Ordering-owned order read adapters.
- `discovery/support/ucp-support`: Discovery-owned catalog/search adapters.
- `deployables/platform-api`: thin composition only.

## Scope For This Pass

Shippable now:

1. OAuth production hardening:
   - Require PKCE S256 on UCP authorization code issuance and redemption.
   - Add refresh token grant with refresh rotation.
   - Add token introspection metadata and endpoint.
   - Add account-level linked platform authorization list/revoke surfaces for consent management.
   - Reject public non-local HTTP redirect/profile URLs.

2. Replay and protocol operations:
   - Add idempotency retention/expiry to the Postgres UCP replay store.
   - Keep expired replay records from blocking new requests.
   - Add pruning support and runtime observer hooks for replay, signature, and operation outcomes.
   - Wire production composition logging for UCP security and replay events.

3. Payment/AP2 hardening:
   - Strengthen AP2 input recognition to require structured mandate fields before accepting it as an AP2 attempt.
   - Keep headless completion disabled unless Payments later owns mandate verification and payment-handler processing.

4. Smoke/conformance:
   - Add a UCP smoke script for profile, OAuth metadata, REST catalog/order health, MCP initialization/tools, and optional bearer-token/order checks.
   - Add tests for PKCE, refresh rotation, introspection, consent revocation, replay retention, observer emission, and payment guardrails.

5. Docs:
   - Update architecture/runbook/ADR readiness notes with what is production-ready after this pass and what still blocks full autonomous AP2 checkout.

Not shippable in this pass without new provider/key decisions:

- Business response signing with production signing keys and rotation.
- Real AP2 mandate verification and headless funds transfer.
- External UCP certification/conformance partner validation.
- Production OAuth dynamic client registration policy beyond profile/redirect URL trust checks.

## Pressure Test

- No new UCP bounded context.
- Auth owns OAuth journey mechanics; Identity owns durable consent/token facts.
- Payments does not accept autonomous money movement until mandate verification is modeled and audited.
- Runtime concerns stay in infrastructure, with deployables only wiring storage, keys, logging, and handlers.
- Greenfield-compatible breaking change: PKCE is required for UCP OAuth codes because UCP identity linking expects Authorization Code with PKCE.

## Verification Plan

- `pnpm run check:structure`
- `pnpm run verify:metadata`
- `pnpm run verify:typecheck`
- Targeted tests for Auth, Identity, Platform Runtime, Payments, Platform API, and UCP smoke args.
- `pnpm run verify:test` if targeted checks are clean.

## PR Plan

Open a PR from `codex/ucp-production-readiness`, ensure CI passes, merge after green checks, then verify `main` CI.
