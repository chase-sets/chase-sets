import type { ResolvedActor } from "@chase-sets/auth/server";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { IdentityApiHostServices } from "./app";

const AUTH_SESSION_COOKIE_NAME = "chase_sets_session";

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

        return [
          part.slice(0, separatorIndex),
          decodeURIComponent(part.slice(separatorIndex + 1)),
        ];
      }),
  );
}

function readAuthSessionToken(request: Request) {
  const cookieToken =
    parseCookieHeader(request.headers.get("cookie")).get(AUTH_SESSION_COOKIE_NAME) ??
    null;
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
}

export function createAuthBootstrapContext(
  services: IdentityApiHostServices["auth"],
): EventStoreContext {
  return {
    tenantId: services.identity.bootstrapTenantId as never,
    audit: {
      performedByUserId: "usr_identity_system" as never,
      forAccountId: "acc_identity_system" as never,
    },
    trace: {},
  };
}

async function resolveActorFromSessionId(
  services: IdentityApiHostServices["auth"],
  sessionId: string,
): Promise<ResolvedActor | null> {
  const session = await services.sessions.getSession(sessionId);
  if (
    !session ||
    session.status !== "active" ||
    new Date(session.expires_at).getTime() <= Date.now()
  ) {
    return null;
  }

  const membership = await services.identity.getActiveMembershipForUserAccount(
    session.user_id,
    session.account_id,
  );

  if (!membership) {
    return null;
  }

  return {
    sessionId: session.session_id,
    tenantId: services.identity.bootstrapTenantId,
    userId: session.user_id,
    accountId: session.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: membership.role_permissions as readonly string[],
  };
}

export async function resolveActorFromRequest(
  services: IdentityApiHostServices["auth"],
  request: Request,
): Promise<ResolvedActor | null> {
  const sessionToken = readAuthSessionToken(request);
  if (!sessionToken) {
    return null;
  }

  const result = await services.db.query<{
    session_id: string;
    expires_at: string;
  }>(
    `SELECT session_id, expires_at
     FROM identity_session_tokens
     WHERE token_hash = $1`,
    [services.auth.hashSecret(sessionToken)],
  );
  const tokenRecord = result.rows[0] ?? null;

  if (!tokenRecord || new Date(tokenRecord.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return resolveActorFromSessionId(services, tokenRecord.session_id);
}
