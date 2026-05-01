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
  createActorEventStoreContext,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import type { PlatformIdentityServices } from "../app";
import {
  createAuthBootstrapContext,
  resolveActorFromRequest,
} from "../auth-request-context";
import { authenticationRequiredResponse } from "@chase-sets/http/responses";

const TENANT_HEADER = "x-tenant-id";
const USER_HEADER = "x-user-id";
const ACCOUNT_HEADER = "x-account-id";
const CORRELATION_HEADER = "x-correlation-id";
const CAUSATION_HEADER = "x-causation-id";
const COMMAND_HEADER = "x-command-id";

export type TenantContextEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
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
  "POST /api/identity/internal/auth/personal-identities",
  "POST /api/identity/internal/auth/users/:id/password-credential",
  "POST /api/identity/internal/auth/invitations/:id/accept",
  "POST /api/identity/api-keys/resolve",
]);

function isAnonymousAllowed(method: string, pathname: string) {
  const signature = `${method.toUpperCase()} ${pathname}`;
  if (ANONYMOUS_ROUTES.has(signature)) {
    return true;
  }

  return (
    method.toUpperCase() === "POST" &&
    (
      /^\/api\/identity\/internal\/auth\/users\/[^/]+\/password-credential$/.test(pathname) ||
      /^\/api\/identity\/internal\/auth\/invitations\/[^/]+\/accept$/.test(pathname)
    )
  );
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

export function createIdentityAuthMiddleware(services: PlatformIdentityServices) {
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

    return c.json(authenticationRequiredResponse(), 401);
  };
}

export type PlatformActorResolver = (
  request: Request,
) => Promise<ResolvedActor | null>;

export function createPlatformActorMiddleware(
  resolveActor: PlatformActorResolver,
) {
  return async function platformActorMiddleware(
    c: Context<TenantContextEnv>,
    next: Next,
  ): Promise<void> {
    const actor = await resolveActor(c.req.raw);

    c.set("actor", actor);
    c.set("context", actor ? createActorEventStoreContext(actor) : null);

    await next();
  };
}
