---
slug: developer-quickstart
title: Developer quickstart
description: Connect an agent to the Chase Sets MCP endpoint, make a first unauthenticated call, and add an authorized call in a few minutes.
audience: developer
category: getting-started
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: The MCP endpoint speaks JSON-RPC 2.0 and answers tools/list and tools/call.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp.test.ts"]
  - claim: Public discovery tools resolve without an access token, while account-scoped tools require an authorized session.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-contracts.test.ts"]
  - claim: The advertised OAuth endpoints and MCP protocol versions match the running server's connector packaging.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/agent-connector-packaging.test.ts"]
---
## What you are building against

Chase Sets exposes a single agent-facing surface: a Model Context Protocol (MCP) server at `https://your-marketplace-host/mcp`. The same server backs every connector — the Claude connector directory, ChatGPT apps, Gemini, and any native MCP client — so there is one endpoint, one tool catalog, and one permission model to learn.

The server speaks JSON-RPC 2.0 over HTTP POST. Its tools, resources, input and output schemas, risk levels, and permission boundaries are defined in code and self-describe over the protocol, so `tools/list` is always the live, authoritative catalog. See the [MCP tool catalog](/developers/mcp-tool-catalog) for how to read a tool descriptor, and [Authenticating agents](/developers/agent-authentication) for the OAuth flow that unlocks account-scoped tools.

Throughout these guides, `your-marketplace-host` is a placeholder for the deployment you are targeting. Resolve it, and the exact protocol versions and OAuth endpoints, from the server's own metadata rather than hard-coding them.

## Step 1: Discover the server

Every MCP client begins by learning what the server supports. The supported protocol versions are advertised in the connector metadata; a client sends the negotiated version in the `MCP-Protocol-Version` header.

List the available tools with a `tools/list` call: `curl -sS -X POST https://your-marketplace-host/mcp -H 'content-type: application/json' -H 'MCP-Protocol-Version: 2025-06-18' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

The response is a JSON-RPC result whose `tools` array carries one descriptor per tool: its `name`, `description`, `inputSchema`, `outputSchema` when defined, and the annotations that describe risk and permission boundary. Read the catalog from this response — never from a copy — so your integration cannot drift from the server.

## Step 2: Make a first unauthenticated call

A few tools are public: they read only buyer-visible marketplace data and need no access token. `discovery.search-market` is the best first call. It accepts free text or a structured set-code and collector-number natural key.

Call it with `tools/call`: `curl -sS -X POST https://your-marketplace-host/mcp -H 'content-type: application/json' -H 'MCP-Protocol-Version: 2025-06-18' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discovery.search-market","arguments":{"query":"SV04 123/182"}}}'`

The result's structured content matches the tool's `outputSchema`: an `items` array of public item rows — each with `catalog_item_id`, `slug`, `title`, and `status` — plus `total`, `count`, and a `nextCursor` for paging. Follow a result into `discovery.get-item-detail` with the item's `slug` to read listings and offer affordances. Both tools are public, so this whole path runs before you wire up any authentication.

## Step 3: Add an authorized call

Account-scoped tools — your inventory, listings, offers, orders, wallet — require an authorized session. Chase Sets uses OAuth 2.0 Authorization Code with PKCE for public clients, with dynamic client registration, so an agent host can connect without a pre-shared secret. The full flow, including scope selection, is in [Authenticating agents](/developers/agent-authentication).

Once you hold an access token, send it as a bearer token on the same endpoint. Reading the current account is the smallest authorized call: `curl -sS -X POST https://your-marketplace-host/mcp -H 'content-type: application/json' -H 'authorization: Bearer YOUR_ACCESS_TOKEN' -H 'MCP-Protocol-Version: 2025-06-18' -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"identity.get-account","arguments":{"accountId":"YOUR_ACCOUNT_ID"}}}'`

`identity.get-account` requires the `account:read` scope. If the token is missing, expired, or lacks the scope, the call is refused with an authorization error naming the missing scope rather than returning partial data. Resolve the acting account and its permission boundary first with the `auth.resolve-actor` tool, which returns the account id you pass to account-scoped tools.

## Step 4: Respect the guardrails before you write

Read tools are safe to call freely. Write tools — creating a listing, submitting an offer, requesting a payout — carry guardrails that the descriptor makes explicit: a required `confirmationText`, a required `idempotencyKey` so a retried call is applied at most once, and `dryRun` support so you can validate an action without committing it. Read [The MCP tool catalog](/developers/mcp-tool-catalog) before invoking any tool whose risk is `sensitive` or `destructive`.

## Where to go next

- [Authenticating agents](/developers/agent-authentication) — the UCP OAuth flow, dynamic client registration, and the scope families.
- [The MCP tool catalog](/developers/mcp-tool-catalog) — how to read risk, permission boundaries, guardrails, and availability, and how planned tools are kept separate from available ones.
