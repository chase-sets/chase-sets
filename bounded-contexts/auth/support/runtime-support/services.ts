import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { createAuthSecretAdapters } from "../auth-support/adapters";
import {
  AUTH_ACCOUNT_SELECTION_TTL_MS,
  AUTH_SESSION_TTL_MS,
  createExpiryTimestamp,
  type AuthMethod,
  toSessionStreamId,
} from "../../features/sessions/domain/auth-flow";
import { AUTH_BOOTSTRAP_TENANT_ID, AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import {
  getAuthIdentityInvitation,
  getAuthIdentityUser,
  getAuthIdentityUserByEmail,
  getAuthIdentityUserByPhone,
  getAuthIdentityUserBySocialLogin,
  getActiveAuthMembershipForUserAccount,
  listActiveAuthMembershipsForUser,
  normalizeAuthEmail,
} from "../auth-support/identity-projection";
import {
  clearMagicLinkDeliveryToken,
  getMagicLinkDeliveryToken,
  insertAccountSelectionToken,
  upsertSessionToken,
} from "../auth-support/store";
import { createSessionRuntime } from "../../features/sessions/api/runtime";
import type { SessionRow } from "../../features/sessions/read-model/queries";
import type { SessionState } from "../../features/sessions/domain/domain";
import type { SocialLoginProvider } from "../social-login-support/providers";

type AuthIdentityReadServices = Readonly<{
  bootstrapTenantId: string;
  normalizeEmail: typeof normalizeAuthEmail;
  getUser: (userId: string) => ReturnType<typeof getAuthIdentityUser>;
  getUserByEmail: (email: string) => ReturnType<typeof getAuthIdentityUserByEmail>;
  getUserByPhone: (phone: string) => ReturnType<typeof getAuthIdentityUserByPhone>;
  getUserBySocialLogin: (
    params: Parameters<typeof getAuthIdentityUserBySocialLogin>[1],
  ) => ReturnType<typeof getAuthIdentityUserBySocialLogin>;
  listActiveMembershipsForUser: (userId: string) => ReturnType<typeof listActiveAuthMembershipsForUser>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<typeof getActiveAuthMembershipForUserAccount>;
  getInvitation: (invitationId: string) => ReturnType<typeof getAuthIdentityInvitation>;
}>;

export type AuthServices = Readonly<{
  pool: PgTransactionalPool;
  db: PgQueryable;
  eventStore: EventStore;
  auth: ReturnType<typeof createAuthSecretAdapters>;
  identity: AuthIdentityReadServices;
  sessions: ReturnType<typeof createSessionRuntime>;
  notificationOutbox: NotificationOutbox;
  socialLoginProviders: readonly SocialLoginProvider[];
  adminGoogleWorkspaceSso: AdminGoogleWorkspaceSsoConfig | null;
  projectors: readonly ProjectionHandlerSet[];
}>;

export type AdminGoogleWorkspaceSsoConfig = Readonly<{
  allowedHostedDomains: readonly string[];
}>;

export type AuthHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
  socialLoginProviders?: readonly SocialLoginProvider[];
  adminGoogleWorkspaceSso?: AdminGoogleWorkspaceSsoConfig | null;
}>;

export function createAuthServices(pool: PgTransactionalPool, ports: AuthHostPorts = {}): AuthServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "auth" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const sessions = createSessionRuntime({
    eventStore,
    checkpointStore,
    db,
    notificationOutbox,
    magicLinkDeliveryTokens: {
      getMagicLinkDeliveryToken: (tokenId) => getMagicLinkDeliveryToken(db, tokenId),
      clearMagicLinkDeliveryToken: (tokenId) => clearMagicLinkDeliveryToken(db, tokenId),
    },
  });

  return {
    pool,
    db,
    eventStore,
    auth: createAuthSecretAdapters(),
    identity: {
      bootstrapTenantId: AUTH_BOOTSTRAP_TENANT_ID,
      normalizeEmail: normalizeAuthEmail,
      getUser: (userId) => getAuthIdentityUser(db, userId),
      getUserByEmail: (email) => getAuthIdentityUserByEmail(db, email),
      getUserByPhone: (phone) => getAuthIdentityUserByPhone(db, phone),
      getUserBySocialLogin: (params) => getAuthIdentityUserBySocialLogin(db, params),
      listActiveMembershipsForUser: (userId) => listActiveAuthMembershipsForUser(db, userId),
      getActiveMembershipForUserAccount: (userId, accountId) =>
        getActiveAuthMembershipForUserAccount(db, userId, accountId),
      getInvitation: (invitationId) => getAuthIdentityInvitation(db, invitationId),
    },
    sessions,
    notificationOutbox,
    socialLoginProviders: ports.socialLoginProviders ?? [],
    adminGoogleWorkspaceSso: ports.adminGoogleWorkspaceSso ?? null,
    projectors: [...sessions.projectors],
  };
}

export type AuthSessionMembership = Awaited<ReturnType<typeof listActiveAuthMembershipsForUser>>[number];

export type AuthSessionStartResult =
  | Readonly<{
      requiresAccountSelection: true;
      memberships: readonly AuthSessionMembership[];
    }>
  | Readonly<{
      requiresAccountSelection: false;
      sessionId: string;
      session: SessionRow;
      memberships: readonly AuthSessionMembership[];
    }>;

export type InteractiveAuthResult =
  | Readonly<{
      type: "account-selection-required";
      userId: string;
      selectionToken: string;
      selectionExpiresAt: string;
      memberships: readonly AuthSessionMembership[];
    }>
  | Readonly<{
      type: "session-started";
      userId: string;
      sessionId: string;
      sessionToken: string;
      session: SessionRow;
      memberships: readonly AuthSessionMembership[];
    }>;

function toSessionRowFromState(state: SessionState, updatedAt: string): SessionRow | null {
  if (!state.id || !state.userId || !state.accountId || !state.authenticationMethod || !state.expiresAt) {
    return null;
  }

  return {
    session_id: state.id,
    user_id: state.userId,
    user_display_name: null,
    user_primary_email: null,
    account_id: state.accountId,
    account_display_name: null,
    account_name: null,
    available_account_ids: state.availableAccountIds,
    authentication_method: state.authenticationMethod,
    status: state.status,
    expires_at: state.expiresAt,
    updated_at: updatedAt,
  };
}

async function getSessionForAuth(services: AuthServices, sessionId: string): Promise<SessionRow | null> {
  const projectedSession = await services.sessions.getSession(sessionId);
  if (projectedSession) {
    return projectedSession;
  }

  const sessionState = await services.sessions.getSessionState(sessionId);
  return sessionState ? toSessionRowFromState(sessionState, new Date().toISOString()) : null;
}

async function startSessionForUser(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: AuthMethod;
    context: EventStoreContext;
    membershipsOverride?: readonly AuthSessionMembership[];
  }>,
): Promise<AuthSessionStartResult> {
  const memberships =
    params.membershipsOverride ?? (await services.identity.listActiveMembershipsForUser(params.userId));
  if (memberships.length === 0) {
    throw new Error("User has no active memberships.");
  }

  const selectedAccountId = params.accountId ?? (memberships.length === 1 ? memberships[0].accountId : undefined);

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
  const expiresAt = createExpiryTimestamp(AUTH_SESSION_TTL_MS);

  const result = await services.sessions.commandHandler({
    streamId: toSessionStreamId(sessionId),
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

  const storedEvents = result.storedEvents ?? [];
  const session = toSessionRowFromState(
    result.state,
    storedEvents[storedEvents.length - 1]?.recordedAt ?? new Date().toISOString(),
  );
  if (!session) {
    throw new Error("Session state was not available after session start.");
  }

  return {
    requiresAccountSelection: false,
    sessionId,
    session,
    memberships,
  };
}

async function issueSessionToken(
  services: AuthServices,
  params: Readonly<{
    sessionId: string;
    expiresAt: string;
  }>,
) {
  const sessionToken = services.auth.issueOpaqueToken("session");
  await upsertSessionToken(services.db, {
    sessionId: params.sessionId,
    tokenHash: services.auth.hashSecret(sessionToken),
    expiresAt: params.expiresAt,
  });

  return sessionToken;
}

async function issueAccountSelectionToken(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    authenticationMethod: AuthMethod;
  }>,
) {
  const tokenId = createId("cmd");
  const selectionToken = services.auth.issueOpaqueToken("acct");
  const selectionExpiresAt = createExpiryTimestamp(AUTH_ACCOUNT_SELECTION_TTL_MS);

  await insertAccountSelectionToken(services.db, {
    tokenId,
    userId: params.userId,
    authenticationMethod: params.authenticationMethod,
    tokenHash: services.auth.hashSecret(selectionToken),
    expiresAt: selectionExpiresAt,
  });

  return {
    selectionToken,
    selectionExpiresAt,
  };
}

export async function startInteractiveAuth(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: AuthMethod;
    context: EventStoreContext;
    membershipsOverride?: readonly AuthSessionMembership[];
  }>,
): Promise<InteractiveAuthResult> {
  const sessionResult = await startSessionForUser(services, params);

  if (sessionResult.requiresAccountSelection) {
    const selection = await issueAccountSelectionToken(services, {
      userId: params.userId,
      authenticationMethod: params.authenticationMethod,
    });

    return {
      type: "account-selection-required",
      userId: params.userId,
      selectionToken: selection.selectionToken,
      selectionExpiresAt: selection.selectionExpiresAt,
      memberships: sessionResult.memberships,
    };
  }

  const sessionToken = await issueSessionToken(services, {
    sessionId: sessionResult.sessionId,
    expiresAt: sessionResult.session.expires_at,
  });

  return {
    type: "session-started",
    userId: params.userId,
    sessionId: sessionResult.sessionId,
    sessionToken,
    session: sessionResult.session,
    memberships: sessionResult.memberships,
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
    streamId: toSessionStreamId(params.sessionId),
    command: { type: "RevokeSession" },
    context: params.context,
  });

  return {
    id: params.sessionId,
    version: result.version,
    status: result.state.status,
  };
}

function resolveRolePermissions(roleKey: string, storedPermissions: readonly string[]) {
  const presetPermissions = AUTH_ROLE_PERMISSIONS[roleKey as keyof typeof AUTH_ROLE_PERMISSIONS] ?? [];
  return Array.from(new Set([...storedPermissions, ...presetPermissions]));
}

export async function resolveActorFromSessionId(
  services: AuthServices,
  sessionId: string,
): Promise<ResolvedActor | null> {
  const session = await getSessionForAuth(services, sessionId);
  if (!session || session.status !== "active" || new Date(session.expires_at).getTime() <= Date.now()) {
    return null;
  }

  const membership = await services.identity.getActiveMembershipForUserAccount(session.user_id, session.account_id);

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
    permissions: resolveRolePermissions(membership.role_key, membership.role_permissions),
  };
}
