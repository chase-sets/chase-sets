import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { TenantId, UserId, AccountId, CorrelationId, CausationId, CommandId } from "@chase-sets/primitives/typed-ids";

const TENANT_HEADER = "x-tenant-id";
const USER_HEADER = "x-user-id";
const ACCOUNT_HEADER = "x-account-id";
const CORRELATION_HEADER = "x-correlation-id";
const CAUSATION_HEADER = "x-causation-id";
const COMMAND_HEADER = "x-command-id";

export type TenantContextEnv = {
  Variables: {
    context: EventStoreContext;
  };
};

export async function tenantContextMiddleware(
  c: Context<TenantContextEnv>,
  next: Next,
): Promise<Response | void> {
  const tenantId = c.req.header(TENANT_HEADER);
  const userId = c.req.header(USER_HEADER);
  const accountId = c.req.header(ACCOUNT_HEADER);

  if (!tenantId || !userId || !accountId) {
    return c.json(
      { error: "Missing required headers: X-Tenant-Id, X-User-Id, X-Account-Id" },
      401,
    );
  }

  const context: EventStoreContext = {
    tenantId: tenantId as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
    trace: {
      correlationId: (c.req.header(CORRELATION_HEADER) as CorrelationId) || undefined,
      causationId: (c.req.header(CAUSATION_HEADER) as CausationId) || undefined,
      commandId: (c.req.header(COMMAND_HEADER) as CommandId) || undefined,
    },
  };

  c.set("context", context);
  await next();
}
