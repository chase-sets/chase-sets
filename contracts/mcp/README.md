# MCP Service Coverage

Chase Sets exposes agent-facing capabilities through MCP descriptors owned by
`@chase-sets/mcp`. The descriptors are contracts, not deployable behavior: each
tool routes to the bounded context or provider adapter that already owns the
domain rule, read model, event emission, and tests.

## Schema

Each MCP service descriptor includes:

- `serviceId`: stable service key.
- `kind`: `bounded-context`, `external-provider`, or `infrastructure`.
- `serviceBoundary`: natural-language ownership boundary.
- `tools`: callable actions with input schemas, expected usage, permission
  boundary, guardrails, and audit policy.
- `resources`: read-only URI templates for account-scoped context.

Each MCP tool descriptor includes:

- `name`: stable tool name, prefixed by service ID.
- `risk`: `read`, `sensitive`, or `destructive`.
- `inputSchema`: JSON-schema-shaped object schema.
- `permissionBoundary.requiredPermissions`: platform permissions required before
  invocation.
- `guardrails.confirmation`: whether the agent host must collect explicit
  confirmation.
- `guardrails.idempotencyKey`: whether write calls must include an idempotency
  key.
- `audit`: event name, target type, and sensitive input fields for audit logs.

## Guardrails

Read tools may be public only when they expose buyer-visible discovery data.
Account-scoped reads require an authenticated actor and the matching view
permission.

Sensitive and destructive tools must:

- require at least one platform permission;
- require explicit confirmation;
- require an idempotency key;
- write through the owning bounded context or provider adapter;
- emit normal domain events or provider inbox audit records.

Provider tools are diagnostic or replay surfaces. Business writes should prefer
the owning bounded context: Payments for payment/refund workflows, Settlement for
payout workflows, and Fulfillment for postage label workflows.

## Covered Services

| Service | Kind | Agent surface |
| --- | --- | --- |
| Auth | bounded context | Resolve actor context, inspect sessions, revoke sessions. |
| Identity | bounded context | Inspect accounts and memberships, invite members, revoke API keys. |
| Catalog | bounded context | Search catalog records, inspect blueprints, publish catalog items. |
| Discovery | bounded context | Search buyer-visible market supply and item detail resources. |
| Inventory | bounded context | Inspect stock, adjust inventory, archive storage locations. |
| Marketplace | bounded context | Inspect listings/offers, publish listings, accept offers. |
| Pricing | bounded context | Recommend prices and explain pricing signals. |
| Commercial Terms | bounded context | Resolve applied terms and publish terms schedules. |
| Checkout | bounded context | Inspect carts, add cart lines, start checkout sessions. |
| Ordering | bounded context | Inspect purchases/sales and cancel eligible orders. |
| Payments | bounded context | Inspect payment state and request refunds. |
| Fulfillment | bounded context | Inspect shipments, purchase labels, void labels. |
| Settlement | bounded context | Inspect wallets/readiness, request payouts, refresh readiness. |
| Reputation | bounded context | Inspect summaries and submit reviews. |
| Insights | bounded context | Inspect account performance summaries. |
| Stripe Payments | external provider | Support-safe payment processor diagnostics. |
| Stripe Connect | external provider | Support-safe payout diagnostics and confirmed webhook replay. |
| EasyPost Postage | external provider | Support-safe label diagnostics and confirmed tracking replay. |

## Expected Usage

Agent hosts should resolve the actor first, list available tools by permission,
read current state through resources or read tools, and then invoke a sensitive
or destructive tool only after collecting confirmation text. Tool calls should
include the actor, account scope, idempotency key for writes, and audit metadata.

## Runtime Bridge

The platform API mounts the MCP bridge at `/mcp`. It supports MCP-style JSON-RPC
requests:

- `initialize`
- `tools/list`
- `resources/list`
- `tools/call`
- `resources/read`

HTTP convenience endpoints are also available:

- `GET /mcp/services`
- `GET /mcp/tools`
- `GET /mcp/resources`

`tools/call` and `resources/read` use the actor resolved by the platform API.
The bridge blocks calls when the actor is missing, lacks the required
permission, lacks an account scope for account-scoped tools, omits confirmation
for sensitive/destructive tools, or omits an idempotency key for write tools.

Tool and resource handlers are registered by runtime composition. If a descriptor
is exposed but no runtime handler is registered, the bridge returns an auditable
safe-boundary error instead of guessing at domain behavior. Bounded contexts and
provider adapters should register handlers that call their owned services and
emit their normal domain events or provider inbox records.

Example tool call:

```json
{
  "jsonrpc": "2.0",
  "id": "request_1",
  "method": "tools/call",
  "params": {
    "name": "settlement.request-payout",
    "arguments": {
      "accountId": "acc_123",
      "amount": "25.00",
      "reason": "Seller requested payout.",
      "idempotencyKey": "agent-request-123",
      "confirmationText": "Request payout."
    },
    "confirmation": {
      "confirmed": true,
      "text": "Request payout."
    }
  }
}
```

The contract tests in `contracts/mcp/index.test.ts` verify service coverage,
schema presence, permission boundaries, confirmation requirements, idempotency
requirements, and successful/failure authorization paths. The runtime tests in
`infrastructure/platform-runtime/mcp.test.ts` verify JSON-RPC listing, successful
registered handler calls, permission failure, confirmation failure, idempotency
failure, audit records, and safe unregistered-handler refusal. The platform API
tests verify the `/mcp` bridge is mounted with actor resolution.
