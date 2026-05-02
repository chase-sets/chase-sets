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

The contract tests in `contracts/mcp/index.test.ts` verify service coverage,
schema presence, permission boundaries, confirmation requirements, idempotency
requirements, and successful/failure authorization paths.
