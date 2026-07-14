---
slug: agent-authentication
title: Authenticating agents
description: How agents authorize to Chase Sets with OAuth 2.0 Authorization Code and PKCE, register dynamically as a public client, and request only the scopes they need.
audience: developer
category: getting-started
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Authorization uses Authorization Code with PKCE S256 for public clients, with no client secret accepted, stored, or returned.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/agent-connector-packaging.test.ts"]
  - claim: The advertised authorize, token, registration, introspection, and revocation endpoints match the running server.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/agent-connector-packaging.test.ts"]
  - claim: Account-scoped tools resolve the caller's granted scopes and refuse calls that exceed them.
    issues: ["#4357"]
    tests: ["infrastructure/platform-runtime/mcp-contracts.test.ts"]
---
## The model in one paragraph

Chase Sets authorizes agents with OAuth 2.0 Authorization Code and PKCE, following the Unified Commerce Protocol (UCP) conventions. Agent hosts connect as public clients: there is no client secret. A human authorizes the agent for a specific account and a specific set of scopes, and the agent receives an access token it presents as a bearer token to the MCP endpoint. This keeps the human in the loop for consent while letting the agent act within a bounded permission set.

## Discover the endpoints, do not hard-code them

The server publishes its OAuth configuration so clients can adapt to any deployment. Protected-resource metadata lives at `https://your-marketplace-host/.well-known/oauth-protected-resource` and authorization-server metadata at `https://your-marketplace-host/.well-known/oauth-authorization-server`. On the current runtime these resolve to:

- Authorization endpoint: `https://your-marketplace-host/ucp/oauth/authorize`
- Token endpoint: `https://your-marketplace-host/ucp/oauth/token`
- Dynamic client registration: `https://your-marketplace-host/ucp/oauth/register`
- Introspection endpoint: `https://your-marketplace-host/ucp/oauth/introspect`
- Revocation endpoint: `https://your-marketplace-host/ucp/oauth/revoke`

Always read these from the well-known metadata at connect time. The values above are the current truth, but the metadata document is the contract.

## Register as a public client

Chase Sets exposes RFC 7591 dynamic client registration, so an agent host can obtain a `client_id` on the fly. Registration is constrained to keep every client public and safe:

- Public clients only: `token_endpoint_auth_method` must be `none`.
- No `client_secret`, `jwks`, or `jwks_uri` is accepted, stored, or returned.
- `redirect_uris` and the client and profile URLs must be HTTPS, or localhost HTTP for local development.
- Registered scopes are limited to the advertised UCP OAuth scopes, and an authorization request can never exceed the registered scopes.
- Authorization Code with PKCE using the S256 method is required.

An agent platform may instead present a trusted Client ID Metadata Document URL as its `client_id`, avoiding a separate registration step. Either way, no confidential credential is ever involved.

## The authorization flow

1. Generate a PKCE code verifier and its S256 challenge.
2. Redirect the human to the authorization endpoint with your `client_id`, `redirect_uri`, the `code_challenge`, `code_challenge_method=S256`, and the exact `scope` set you need.
3. The human signs in, selects the account to authorize, and consents to the requested scopes.
4. Exchange the returned authorization code at the token endpoint together with the `code_verifier` to receive an access token and a refresh token.
5. Call the MCP endpoint with `authorization: Bearer YOUR_ACCESS_TOKEN`. Use the refresh token to obtain a new access token when it expires, and the revocation endpoint to end access.

## Request only the scopes you need

Scopes are grouped into families, and each account-scoped tool declares the scope it requires in its descriptor. Request the narrowest set that covers your workflow — the server refuses any tool call whose granted scopes do not cover the tool's required scope, naming the missing scope rather than returning partial data.

- `catalog:read` — read canonical catalog items and blueprints.
- `inventory:read`, `inventory:write` — read inventory and hold-derived availability; create import batches and adjust stock.
- `listings:read`, `listings:write` — read listings and seller insights; create, price, publish, and unpublish listings.
- `offers:read`, `offers:write` — read offers and matches; submit and counter offers.
- `checkout:read`, `checkout:write` — read the cart; add, update, and remove cart lines and manage the checkout session.
- `order:read` — read orders on either side of a sale.
- `fulfillment:read`, `fulfillment:write` — read shipments and tracking; purchase and void labels.
- `payouts:read`, `payouts:request` — read the wallet, ledger, and payouts; request a payout.
- `account:read`, `account:manage` — read account profile and reputation; manage memberships and account settings.
- `support:read`, `support:write` — read and act on support requests.

Public tools such as `discovery.search-market` require no token and no scope at all, so read-only marketplace discovery needs no authorization.

## After authorizing

Call `auth.resolve-actor` first: it returns the acting account and its permission boundary, so you know which account id to pass and which tools the granted scopes permit before you attempt them. From there, follow the [Developer quickstart](/developers/developer-quickstart) into your first authorized call, or the [MCP tool catalog](/developers/mcp-tool-catalog) to plan a multi-step workflow.
