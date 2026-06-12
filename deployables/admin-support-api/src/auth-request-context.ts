import type { ResolvedActor } from "@chase-sets/auth/server";
import { readAuthSessionToken } from "@chase-sets/auth-context";
import type { PlatformIdentityServices } from "./app";

async function resolveActorFromSessionId(
  services: PlatformIdentityServices["auth"],
  sessionId: string,
): Promise<ResolvedActor | null> {
  const session = await services.sessions.getSession(sessionId);
  if (!session || session.status !== "active" || new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const membership = await services.identity.getActiveMembershipForUserAccount(session.user_id, session.account_id);

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
  services: PlatformIdentityServices["auth"],
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
