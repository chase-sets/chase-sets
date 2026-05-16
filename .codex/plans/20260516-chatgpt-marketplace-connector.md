# ChatGPT Marketplace Connector

## Intent

Build a ChatGPT-usable headless marketplace connector on top of existing UCP support.

The connector must let users interact with Chase Sets marketplace capabilities through ChatGPT without introducing a new commerce model or moving behavior out of owning bounded contexts.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-chatgpt-connector`
- Branch: `codex/ucp-chatgpt-connector`
- Base: `main` at `612d59b6 Harden UCP agentic payment path`
- Sandbox id: `111a7017`
- Dependency setup: complete via `pnpm run deps:install`
- Sandbox doctor: clean via `pnpm run sandbox:doctor`
- Local services:
  - Marketplace: `http://localhost:6353`
  - Platform API: `http://localhost:6362`
- Setup blockers: none

## Owning Contexts

- Infrastructure/platform-runtime owns remote MCP transport compatibility, request/response framing, profile metadata plumbing, idempotency guardrails, signature plumbing, and transport-level auth negotiation.
- `@chase-sets/ucp` owns UCP protocol constants, profile declarations, tool descriptors, envelopes, and transport-neutral connector metadata.
- Discovery owns buyer-visible marketplace search and product lookup behavior.
- Checkout owns cart and checkout session behavior.
- Ordering owns purchase/sale/order reads.
- Payments owns AP2 mandate and agentic payment handoff decisions.
- Auth owns OAuth authorization-code-with-PKCE journey and OAuth metadata.
- Identity owns durable linked platform authorization and consent facts.

Do not create a new `chatgpt`, `connector`, `ai-commerce`, or `ucp` bounded context.

## Resolved Decisions

- UCP remains a protocol facade over existing bounded-context behavior, consistent with ADR 0002.
- The connector should reuse existing UCP handlers and not call marketplace browser routes or deployable-local APIs as its source of truth.
- Current OpenAI docs use "apps" for what were formerly ChatGPT connectors. The user-facing repo term can remain "ChatGPT connector" where that matches request language, but implementation should target ChatGPT Apps remote MCP compatibility.
- ChatGPT Developer Mode can use arbitrary MCP tools, including writes, with confirmation controls. Data-only ChatGPT apps for deep research/company knowledge should expose `search` and `fetch`, but this marketplace connector needs headless commerce tools rather than only data retrieval.
- Existing Chase Sets `/ucp/mcp` is JSON-RPC over plain POST and advertises UCP tool names. Current ChatGPT Apps docs require a remote MCP server using SSE or streamable HTTP. The likely implementation gap is transport compatibility, not new domain capability.
- V1 will expose the existing UCP shopping tools directly to ChatGPT instead of adding a ChatGPT-specific wrapper tool layer. This keeps one protocol surface, avoids drift from UCP, and reuses the same context-owned handlers and guardrails already being hardened.
- V1 should advertise mixed authentication for ChatGPT Apps compatibility: unauthenticated initialize/tool discovery plus OAuth-backed account-scoped tools. This matches OpenAI Developer Mode support for Mixed Authentication and the repo's existing public catalog plus Auth/Identity-owned UCP OAuth linking.
- The connector implementation should target streamable HTTP first, because current ChatGPT Apps docs list streamable HTTP and SSE as supported MCP protocols and the existing Hono route can most directly evolve into streamable HTTP.
- Contradiction found: ChatGPT Apps MCP auth can provide OAuth, but current UCP signed checkout writes require request-level `UCP-Agent`, `Signature`, `Content-Digest`, and sometimes `Idempotency-Key` headers. ChatGPT app tool calls do not appear to provide UCP HTTP Message Signature headers, so direct UCP checkout completion/cancellation cannot work from ChatGPT without either remaining a trusted UI handoff or adding an OAuth-only ChatGPT write policy.
- ChatGPT V1 will allow headless search, product lookup, checkout preparation, and order reads, but checkout completion remains a trusted UI handoff unless the caller is a real signed UCP/AP2 agent. ChatGPT OAuth alone must not bypass UCP signed-write/AP2 invariants.

## Open Questions

- None currently blocking implementation.

## Implementation Checklist

- [x] Confirm connector scope and naming.
- [x] Create the implementation goal.
- [x] Add ChatGPT-compatible remote MCP transport support for the existing UCP MCP tool surface, if direct compatibility is not already sufficient.
- [x] Add precise tool schemas and descriptions that help ChatGPT choose marketplace actions safely.
- [x] Preserve OAuth identity linking for account-scoped operations.
- [x] Preserve signed request, digest, and idempotency guardrails for checkout writes.
- [x] Ensure ChatGPT OAuth-only completion returns trusted UI handoff and cannot trigger AP2 headless payment without signed UCP request evidence.
- [x] Add focused contract/runtime tests for ChatGPT-compatible tool listing and tool calls.
- [x] Update UCP connector docs/runbook with ChatGPT Apps setup and local/staging smoke steps.
- [x] Run static checks and focused tests.
- [ ] Create PR and follow CI/deploy verification through merge according to goal criteria.

## Verification

- `pnpm --filter @chase-sets/ucp test`: passed.
- `pnpm --filter @chase-sets/platform-runtime test`: passed.
- `pnpm --filter @chase-sets/ucp typecheck`: passed.
- `pnpm --filter @chase-sets/platform-runtime typecheck`: passed.
- `pnpm run verify:static`: passed.
- `pnpm run check:structure`: passed.
- `pnpm run check:no-any`: passed.
- `pnpm run verify:typecheck`: passed.

## Documentation To Promote

- Update `docs/architecture/ucp-agent-commerce.md` with the ChatGPT Apps compatibility decision.
- Update `docs/runbooks/ucp-agent-commerce.md` with ChatGPT app setup and smoke tests.
- Update `docs/api/` only if the public protocol surface or OpenAPI-visible REST behavior changes.
- No ADR expected unless the plan chooses a hard-to-reverse connector-specific protocol fork.

## Goal Completion Criteria

- Implementation remains in the feature worktree and branch above.
- The retained plan file is committed with the implementation.
- Bounded-context behavior remains owned by Discovery, Checkout, Ordering, Payments, Auth, and Identity.
- `@chase-sets/ucp` and `@chase-sets/platform-runtime/ucp` own only protocol/transport contracts and runtime guardrails.
- Automated checks include focused UCP/connector tests plus repo static checks appropriate to touched packages.
- No UI visual verification is required unless implementation adds visible consent or management UI.
- A draft PR is submitted for review.
- CI passes before marking ready.
- PR is merged after review.
- Preview deployment is verified for `/.well-known/ucp`, OAuth metadata, ChatGPT-compatible MCP initialize/tools/list/tool call, and UCP REST smoke.
- Preview resources are cleaned up after verification where applicable.
- Staging deployment is verified for the same connector smokes.
- Production deployment is verified if the merge reaches `main`.
