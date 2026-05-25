import {
  resolveActorFromSessionId as resolveAuthActorFromSessionId,
  type ResolvedActor,
} from "@chase-sets/auth/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PlatformIdentityServices } from "./app";

const AUTH_SESSION_COOKIE_NAME = "chase_sets_session";
const AUTH_GUEST_CHECKOUT_COOKIE_NAME = "chase_sets_guest_checkout";

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex < 0) {
          return [part, ""];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

function readAuthSessionToken(request: Request) {
  const cookieToken = parseCookieHeader(request.headers.get("cookie")).get(AUTH_SESSION_COOKIE_NAME) ?? null;
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function createAuthBootstrapContext(services: PlatformIdentityServices["auth"]): EventStoreContext {
  return {
    tenantId: services.identity.bootstrapTenantId as never,
    audit: {
      performedByUserId: "usr_identity_system" as never,
      forAccountId: "acc_identity_system" as never,
    },
    trace: {},
  };
}

async function resolveGuestCheckoutActor(
  services: PlatformIdentityServices["auth"],
  request: Request,
): Promise<ResolvedActor | null> {
  const guestToken = parseCookieHeader(request.headers.get("cookie")).get(AUTH_GUEST_CHECKOUT_COOKIE_NAME) ?? null;
  if (!guestToken) {
    return null;
  }

  const result = await services.db.query<{
    token_id: string;
    account_id: string;
    expires_at: string;
  }>(
    `SELECT token_id, account_id, expires_at
     FROM identity_guest_checkout_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [services.auth.hashSecret(guestToken)],
  );
  const tokenRecord = result.rows[0] ?? null;
  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return {
    sessionId: `guest:${tokenRecord.token_id}`,
    tenantId: services.identity.bootstrapTenantId,
    userId: "usr_guest_checkout",
    accountId: tokenRecord.account_id,
    membershipId: `guest:${tokenRecord.token_id}`,
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  };
}

export async function resolveActorFromRequest(
  services: PlatformIdentityServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const linkedActor = await resolveLinkedPlatformActor(services, request);
  if (linkedActor) {
    return linkedActor;
  }

  const sessionToken = readAuthSessionToken(request);
  if (!sessionToken) {
    return resolveGuestCheckoutActor(services.auth, request);
  }

  const result = await services.auth.db.query<{
    session_id: string;
    expires_at: string;
  }>(
    `SELECT session_id, expires_at
     FROM identity_session_tokens
     WHERE token_hash = $1`,
    [services.auth.auth.hashSecret(sessionToken)],
  );
  const tokenRecord = result.rows[0] ?? null;

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return resolveGuestCheckoutActor(services.auth, request);
  }

  return (
    (await resolveAuthActorFromSessionId(services.auth, tokenRecord.session_id)) ??
    (await resolveGuestCheckoutActor(services.auth, request))
  );
}

async function resolveLinkedPlatformActor(
  services: PlatformIdentityServices,
  request: Request,
): Promise<ResolvedActor | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token.startsWith("ucp_at_")) {
    return null;
  }

  const linked = await services.identity.linkedPlatformAuthorizations.resolveAccessToken(
    services.auth.auth.hashSecret(token),
  );
  if (!linked) {
    return null;
  }

  const membership = await services.auth.identity.getActiveMembershipForUserAccount(linked.user_id, linked.account_id);
  if (!membership) {
    return null;
  }

  return {
    sessionId: `ucp:${linked.authorization_id}`,
    tenantId: services.auth.identity.bootstrapTenantId,
    userId: linked.user_id,
    accountId: linked.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: scopedPermissions(linked.scopes, membership.role_permissions as readonly string[]),
  };
}

function scopedPermissions(scopes: readonly string[], membershipPermissions: readonly string[]) {
  const allowed = new Set<string>();
  if (scopes.includes("catalog:read")) {
    allowed.add("catalog.view");
    allowed.add("listings.view");
  }
  if (scopes.includes("checkout:read") || scopes.includes("order:read")) {
    allowed.add("orders.view");
  }
  if (scopes.includes("checkout:write")) {
    allowed.add("orders.manage");
  }

  return membershipPermissions.filter((permission) => allowed.has(permission));
}
