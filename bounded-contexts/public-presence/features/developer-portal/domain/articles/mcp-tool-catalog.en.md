---
slug: mcp-tool-catalog
title: The MCP tool catalog
description: How to read a Chase Sets MCP tool descriptor — risk level, permission boundary, schemas, guardrails, and availability — and why the catalog cannot drift from the code.
audience: developer
category: getting-started
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Every tool self-describes its risk level, permission boundary, schemas, and expected usage over the protocol.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-contracts.test.ts"]
  - claim: Write tools require a confirmation and an idempotency key and support a dry run; read tools require none of these.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-contracts.test.ts"]
  - claim: Available tools are separated from planned tools by an availability marker on each descriptor.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-contracts.test.ts"]
  - claim: Repeated calls to a tool are bounded by a per-tool call limiter.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-tool-call-limiter.test.ts"]
---
## The catalog is the code

The Chase Sets tool catalog is defined once, in the platform's MCP registry, and self-describes over the protocol. A `tools/list` call returns the authoritative catalog for the deployment you are connected to; the connector packaging that agent directories consume is generated from the same registry. There is no second, hand-maintained description to fall out of date — the catalog you read is the catalog the server enforces.

Because of that, build your integration against the live `tools/list` response and each tool's declared schemas, not against a snapshot pasted into your own code.

## Reading a tool descriptor

Every tool carries the same shape. Learn these fields once and you can read any tool:

- `name` — the fully qualified tool name, for example `discovery.search-market` or `settlement.request-payout`. The prefix is the owning service.
- `description` and `title` — what the tool does, in plain language.
- `inputSchema` and `outputSchema` — JSON Schemas for the arguments and the structured result. Required fields, enums, and nested shapes are all declared, so you can validate before calling and parse with confidence.
- `risk` — `read`, `sensitive`, or `destructive`. Risk drives which guardrails apply.
- The permission boundary — the access scope (`public`, `actor`, `account`, or `operator`), the required permissions, and the required OAuth scopes. This tells you exactly what a caller must hold.
- `expectedUsage` — short guidance on when to reach for the tool, including which reads to do first.

## Risk levels and guardrails

The risk level is a contract about side effects, and it determines the guardrails the server requires:

- `read` tools return only data the caller can already see. They need no confirmation and no idempotency key.
- `sensitive` tools change account state — creating a listing, submitting an offer, committing an inventory import. They require a `confirmationText` echoing the exact action, a stable `idempotencyKey` so a retried call is applied at most once, and they support a `dryRun` that validates without committing.
- `destructive` tools, such as revoking a session or an API key, carry the same write guardrails and should be reserved for explicit remediation.

Treat the `idempotencyKey` as mandatory engineering, not a formality: generate one stable value per logical action and resend the same value on every retry, so a network retry never double-applies a write.

## Availability: available versus planned

Each descriptor carries an availability marker. Tools marked available are landed and enforced today. Tools marked planned model a surface that is described but not yet callable, so agent authors can see the roadmap without mistaking it for live capability. Filter on availability when you plan a workflow: build against available tools, and treat planned tools as a preview of what is coming rather than something to depend on now.

The public discovery tools and the first account-scoped reads — resolving the actor, reading an account, checking an authenticity case — are available today. Many write tools across inventory, listings, offers, checkout, fulfillment, and settlement are modeled in the catalog with their full schemas and guardrails; consult the live `tools/list` response for each tool's current availability rather than assuming it.

## Usage limits

Repeated calls to a tool are bounded by a per-tool call limiter, so an agent cannot exhaust a workflow by hammering one tool. Design for it: page through results with the `cursor` or `offset` a tool provides instead of re-issuing the same call, cache stable reads within a session, and back off when a call is limited. The specific limits are policy-governed and enforced by the runtime rather than fixed in your client.

## Putting it together

A typical account-scoped workflow reads before it writes: resolve the actor, read the relevant records, then invoke a write tool with a confirmation and idempotency key. Start from the [Developer quickstart](/developers/developer-quickstart) for the first calls, and [Authenticating agents](/developers/agent-authentication) for the scopes each tool requires.
