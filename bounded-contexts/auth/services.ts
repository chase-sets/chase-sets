import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { createAuthSecretAdapters } from "./auth-support/adapters";
import { AUTH_BOOTSTRAP_TENANT_ID } from "./auth-support/constants";
import {
  getAuthIdentityInvitation,
  getAuthIdentityUser,
  getAuthIdentityUserByEmail,
  getActiveAuthMembershipForUserAccount,
  listActiveAuthMembershipsForUser,
  normalizeAuthEmail,
} from "./auth-support/identity-projection";
import { createSessionRuntime } from "./sessions/runtime";

type AuthIdentityReadServices = Readonly<{
  bootstrapTenantId: string;
  normalizeEmail: typeof normalizeAuthEmail;
  getUser: (userId: string) => ReturnType<typeof getAuthIdentityUser>;
  getUserByEmail: (email: string) => ReturnType<typeof getAuthIdentityUserByEmail>;
  listActiveMembershipsForUser: (
    userId: string,
  ) => ReturnType<typeof listActiveAuthMembershipsForUser>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<typeof getActiveAuthMembershipForUserAccount>;
  getInvitation: (
    invitationId: string,
  ) => ReturnType<typeof getAuthIdentityInvitation>;
}>;

export type AuthServices = Readonly<{
  pool: PgTransactionalPool;
  db: PgQueryable;
  auth: ReturnType<typeof createAuthSecretAdapters>;
  identity: AuthIdentityReadServices;
  sessions: ReturnType<typeof createSessionRuntime>;
  projectors: readonly Projector[];
}>;

export function createAuthServices(
  pool: PgTransactionalPool,
): AuthServices {
  const eventStore = createPostgresEventStore({ pool });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const sessions = createSessionRuntime({ eventStore, checkpointStore, db });

  return {
    pool,
    db,
    auth: createAuthSecretAdapters(),
    identity: {
      bootstrapTenantId: AUTH_BOOTSTRAP_TENANT_ID,
      normalizeEmail: normalizeAuthEmail,
      getUser: (userId) => getAuthIdentityUser(db, userId),
      getUserByEmail: (email) => getAuthIdentityUserByEmail(db, email),
      listActiveMembershipsForUser: (userId) =>
        listActiveAuthMembershipsForUser(db, userId),
      getActiveMembershipForUserAccount: (userId, accountId) =>
        getActiveAuthMembershipForUserAccount(db, userId, accountId),
      getInvitation: (invitationId) => getAuthIdentityInvitation(db, invitationId),
    },
    sessions,
    projectors: [...sessions.projectors],
  };
}

export async function drainAuthProjectors(services: AuthServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export type AuthSessionMembership = Awaited<
  ReturnType<typeof listActiveAuthMembershipsForUser>
>[number];

export type AuthSessionStartResult =
  | Readonly<{
      requiresAccountSelection: true;
      memberships: readonly AuthSessionMembership[];
    }>
  | Readonly<{
      requiresAccountSelection: false;
      sessionId: string;
      session: NonNullable<Awaited<ReturnType<AuthServices["sessions"]["getSession"]>>>;
      memberships: readonly AuthSessionMembership[];
    }>;

export async function startSessionForUser(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
    context: EventStoreContext;
    membershipsOverride?: readonly AuthSessionMembership[];
  }>,
): Promise<AuthSessionStartResult> {
  const memberships =
    params.membershipsOverride ??
    (await services.identity.listActiveMembershipsForUser(params.userId));
  if (memberships.length === 0) {
    throw new Error("User has no active memberships.");
  }

  const selectedAccountId =
    params.accountId ??
    (memberships.length === 1 ? memberships[0].accountId : undefined);

  if (!selectedAccountId) {
    return {
      requiresAccountSelection: true,
      memberships,
    };
  }

  const availableAccountIds = memberships.map((membership) => membership.accountId);
  if (!availableAccountIds.includes(selectedAccountId)) {
    throw new Error("Selected account is not available for this user.");
  }

  const sessionId = createId("ses");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();

  await services.sessions.commandHandler({
    streamId: `auth.session-${sessionId}`,
    command: {
      type: "StartSession",
      sessionId,
      userId: params.userId as UserId,
      accountId: selectedAccountId as AccountId,
      availableAccountIds,
      authenticationMethod: params.authenticationMethod,
      expiresAt,
    },
    context: params.context,
  });

  await drainAuthProjectors(services);
  const session = await services.sessions.getSession(sessionId);
  if (!session) {
    throw new Error("Session projection was not available after session start.");
  }

  return {
    requiresAccountSelection: false,
    sessionId,
    session,
    memberships,
  };
}

export async function revokeSession(
  services: AuthServices,
  params: Readonly<{
    sessionId: string;
    context: EventStoreContext;
  }>,
) {
  const result = await services.sessions.commandHandler({
    streamId: `auth.session-${params.sessionId}`,
    command: { type: "RevokeSession" },
    context: params.context,
  });

  await drainAuthProjectors(services);

  return {
    id: params.sessionId,
    version: result.version,
    status: result.state.status,
  };
}

export async function resolveActorFromSessionId(
  services: AuthServices,
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
    tenantId: AUTH_BOOTSTRAP_TENANT_ID,
    userId: session.user_id,
    accountId: session.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: membership.role_permissions as readonly string[],
  };
}
