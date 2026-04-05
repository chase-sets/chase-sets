import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  CausationId,
  CommandId,
  CorrelationId,
  TenantId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import {
  type ResolvedActor,
} from "@chase-sets/auth/server";
import { createActorEventStoreContext } from "@chase-sets/auth-runtime";
import type { IdentityApiHostServices } from "../app";
import {
  createAuthBootstrapContext,
  resolveActorFromRequest,
} from "../auth-request-context";

const TENANT_HEADER = "x-tenant-id";
const USER_HEADER = "x-user-id";
const ACCOUNT_HEADER = "x-account-id";
const CORRELATION_HEADER = "x-correlation-id";
const CAUSATION_HEADER = "x-causation-id";
const COMMAND_HEADER = "x-command-id";

export type TenantContextEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

const ANONYMOUS_ROUTES = new Set([
  "POST /api/auth/register",
  "POST /api/auth/password-sign-in",
  "POST /api/auth/magic-link/request",
  "POST /api/auth/magic-link/consume",
  "POST /api/auth/passkeys/challenge",
  "POST /api/auth/passkeys/sign-in",
  "POST /api/auth/invitations/accept",
  "POST /api/auth/account-selection/resolve",
  "POST /api/auth/account-selection/complete",
  "POST /api/identity/api-keys/resolve",
]);

function isAnonymousAllowed(method: string, pathname: string) {
  return ANONYMOUS_ROUTES.has(`${method.toUpperCase()} ${pathname}`);
}

function createContextFromHeaders(request: Request) {
  const tenantId = request.headers.get(TENANT_HEADER);
  const userId = request.headers.get(USER_HEADER);
  const accountId = request.headers.get(ACCOUNT_HEADER);

  if (!tenantId || !userId || !accountId) {
    return null;
  }

  return {
    tenantId: tenantId as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
    trace: {
      correlationId: (request.headers.get(CORRELATION_HEADER) as CorrelationId) || undefined,
      causationId: (request.headers.get(CAUSATION_HEADER) as CausationId) || undefined,
      commandId: (request.headers.get(COMMAND_HEADER) as CommandId) || undefined,
    },
  } satisfies EventStoreContext;
}

export function createIdentityAuthMiddleware(services: IdentityApiHostServices) {
  return async function identityAuthMiddleware(
    c: Context<TenantContextEnv>,
    next: Next,
  ): Promise<Response | void> {
    const pathname = new URL(c.req.url).pathname;
    const headerContext = createContextFromHeaders(c.req.raw);

    if (headerContext) {
      c.set("context", headerContext);
      c.set("actor", null);
      await next();
      return;
    }

    const actor = await resolveActorFromRequest(services.auth, c.req.raw);
    if (actor) {
      c.set("actor", actor);
      c.set("context", createActorEventStoreContext(actor));
      await next();
      return;
    }

    if (isAnonymousAllowed(c.req.method, pathname)) {
      c.set("actor", null);
      c.set("context", createAuthBootstrapContext(services.auth));
      await next();
      return;
    }

    return c.json({ error: "Authentication required." }, 401);
  };
}
