import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { isSocialLoginProviderKey, type ResolvedActor } from "@chase-sets/auth-context";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";
import { createAuthSecretAdapters } from "../auth-support/adapters";
import {
  authSecurityLifetimesOf,
  createExpiryTimestamp,
  resolveAuthSecurityLifetimesMs,
  type AuthMethod,
  type AuthSecurityLifetimesMs,
  toSessionStreamId,
} from "../../features/sessions/domain/auth-flow";
import { AUTH_BOOTSTRAP_TENANT_ID, AUTH_ROLE_PERMISSIONS } from "../auth-support/constants";
import {
  getAuthIdentityInvitation,
  getPendingAuthIdentityInvitationByEmail,
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
import {
  DEFAULT_REGISTRATION_ADMISSION_CONFIG,
  type RegistrationAdmissionConfig,
} from "../api-support/registration-gates";
import {
  createPostgresAgentWebhookOutbox,
  type AgentWebhookOutbox,
  type AgentWebhookTarget,
} from "../ucp-support/agent-webhooks";
import { publishAuthenticationCsatOutcomeFact } from "../request-support/csat-outcome-facts";
import {
  createAuthIdentityInvitationProjectionPositionReader,
  createInvitationProjectionFreshnessWaiter,
  type InvitationProjectionFreshnessWaiter,
} from "./invitation-projection-freshness";

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
  findPendingInvitationByEmail: (email: string) => ReturnType<typeof getPendingAuthIdentityInvitationByEmail>;
}>;

export type RegistrationAdmissionHostConfig = RegistrationAdmissionConfig &
  Readonly<{
    findAdmittedWaitlistSignupByEmail?: (
      email: string,
    ) => Promise<Readonly<{ signup_id: string; beta_invitation_id: string; admitted_wave: number }> | null>;
    screeningObserver?: {
      record: (
        event: Readonly<{
          decision: "blocked" | "log-only";
          emailDomain: string;
          reason: "disposable-email-domain";
        }>,
      ) => void | Promise<void>;
    };
  }>;

export type AuthServices = Readonly<{
  pool: PgTransactionalPool;
  db: PgQueryable;
  eventStore: EventStore;
  auth: ReturnType<typeof createAuthSecretAdapters>;
  identity: AuthIdentityReadServices;
  /**
   * Bounded, best-effort read-your-write settle for Auth's invitation
   * projection. The acceptance-link handler consumes a forwarded fresh-write
   * receipt through this before reading the invitation so a just-created or
   * resent invitation is observed. Always populated by `createAuthServices`;
   * optional on the type only so unit-test service doubles that stub a handful
   * of fields keep typechecking (a missing waiter degrades to today's
   * no-wait behavior).
   */
  awaitInvitationProjectionFreshness?: InvitationProjectionFreshnessWaiter;
  sessions: ReturnType<typeof createSessionRuntime>;
  notificationOutbox: NotificationOutbox;
  agentWebhookOutbox: AgentWebhookOutbox;
  agentWebhookOrderResolvers: AgentWebhookOrderResolvers;
  socialLoginProviders: readonly SocialLoginProvider[];
  adminGoogleWorkspaceSso: AdminGoogleWorkspaceSsoConfig | null;
  registrationAdmission: RegistrationAdmissionHostConfig;
  projectors: readonly ProjectionHandlerSet[];
  /**
   * Bounds-validated session/token lifetimes. Always populated by
   * `createAuthServices`; optional on the type only so unit-test doubles
   * that stub a handful of fields keep typechecking -- see
   * `authSecurityLifetimesOf` for the safe accessor every call site uses.
   */
  securityLifetimes?: AuthSecurityLifetimesMs;
}>;

export type AdminGoogleWorkspaceSsoConfig = Readonly<{
  allowedHostedDomains: readonly string[];
}>;

export type AuthHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
  agentWebhookOrderResolvers?: AgentWebhookOrderResolvers;
  socialLoginProviders?: readonly SocialLoginProvider[];
  adminGoogleWorkspaceSso?: AdminGoogleWorkspaceSsoConfig | null;
  registrationAdmission?: RegistrationAdmissionHostConfig;
  /**
   * Deployable-supplied overrides for security lifetimes, bounds-validated
   * by `resolveAuthSecurityLifetimesMs` at construction. ENV-TIER BY DESIGN:
   * platform-api's config reader is the only sanctioned source -- never wire
   * this from the admin-editable platform-policy machinery. See
   * `bounded-contexts/auth/docs/security-lifetimes.md`.
   */
  securityLifetimes?: Partial<AuthSecurityLifetimesMs>;
}>;

export type AgentWebhookOrderResolvers = Readonly<{
  resolveOrderRecipient: (orderId: string) => Promise<string | null>;
  resolveShipmentOrderId: (shipmentId: string) => Promise<string | null>;
  resolveWebhookTargets: (accountId: string) => Promise<readonly AgentWebhookTarget[]>;
}>;

const noopAgentWebhookOrderResolvers: AgentWebhookOrderResolvers = {
  resolveOrderRecipient: async () => null,
  resolveShipmentOrderId: async () => null,
  resolveWebhookTargets: async () => [],
};

function resolveRegistrationAdmissionConfig(
  config: RegistrationAdmissionHostConfig | undefined,
): RegistrationAdmissionHostConfig {
  return {
    ...DEFAULT_REGISTRATION_ADMISSION_CONFIG,
    ...config,
    findAdmittedWaitlistSignupByEmail: config?.findAdmittedWaitlistSignupByEmail,
    disposableEmailDomains: [
      ...new Set([
        ...DEFAULT_REGISTRATION_ADMISSION_CONFIG.disposableEmailDomains,
        ...(config?.disposableEmailDomains ?? []),
      ]),
    ],
  };
}

export function createAuthServices(pool: PgTransactionalPool, ports: AuthHostPorts = {}): AuthServices {
  // Bounds-validated at host boot -- fails closed before any request is
  // served if a deployable's env override is out of range.
  const securityLifetimes = resolveAuthSecurityLifetimesMs(ports.securityLifetimes);
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "auth" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const agentWebhookOutbox = createPostgresAgentWebhookOutbox({ db });
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
      findPendingInvitationByEmail: (email) => getPendingAuthIdentityInvitationByEmail(db, email),
    },
    awaitInvitationProjectionFreshness: createInvitationProjectionFreshnessWaiter({
      readInvitationProjectionPosition: createAuthIdentityInvitationProjectionPositionReader(db),
    }),
    sessions,
    notificationOutbox,
    agentWebhookOutbox,
    agentWebhookOrderResolvers: ports.agentWebhookOrderResolvers ?? noopAgentWebhookOrderResolvers,
    socialLoginProviders: ports.socialLoginProviders ?? [],
    adminGoogleWorkspaceSso: ports.adminGoogleWorkspaceSso ?? null,
    registrationAdmission: resolveRegistrationAdmissionConfig(ports.registrationAdmission),
    projectors: [...sessions.projectors],
    securityLifetimes,
  };
}

export type AuthSessionMembership = Awaited<ReturnType<typeof listActiveAuthMembershipsForUser>>[number];

const EMAIL_VERIFICATION_RESTRICTED_PERMISSIONS = new Set(["listings.manage", "offers.manage", "orders.manage"]);

function hasVerifiedEmailForCommerce(
  user: Awaited<ReturnType<typeof getAuthIdentityUser>> | null,
  authenticationMethod: string | null,
) {
  if (!user?.primary_email) {
    return true;
  }

  const primaryEmail = normalizeAuthEmail(user.primary_email);
  const contactMethods = Array.isArray(user.contact_methods) ? user.contact_methods : [];
  const primaryEmailMethod = contactMethods.find(
    (method): method is { type: string; value: string; verifiedAt: string | null } =>
      Boolean(method) &&
      typeof method === "object" &&
      (method as { type?: unknown }).type === "email" &&
      typeof (method as { value?: unknown }).value === "string" &&
      normalizeAuthEmail((method as { value: string }).value) === primaryEmail,
  );
  if (primaryEmailMethod?.verifiedAt) {
    return true;
  }

  const socialLinks = Array.isArray(user.social_login_links) ? user.social_login_links : [];
  if (
    socialLinks.some(
      (link) =>
        link &&
        typeof link === "object" &&
        typeof (link as { email?: unknown }).email === "string" &&
        normalizeAuthEmail((link as { email: string }).email) === primaryEmail,
    )
  ) {
    return true;
  }

  return authenticationMethod === "google" || authenticationMethod === "facebook";
}

function restrictPermissionsForUnverifiedEmail(
  permissions: readonly string[],
  user: Awaited<ReturnType<typeof getAuthIdentityUser>> | null,
  authenticationMethod: string | null,
) {
  if (hasVerifiedEmailForCommerce(user, authenticationMethod)) {
    return permissions;
  }

  return permissions.filter((permission) => !EMAIL_VERIFICATION_RESTRICTED_PERMISSIONS.has(permission));
}

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

/**
 * Rehydrates a `SessionRow` from the in-memory aggregate.
 *
 * `startedAt` is supplied by the caller rather than derived here because
 * `SessionState` carries no timestamp: the only authority for a session's
 * moment of authentication is the stored `auth.session.started` event. `null`
 * means that authority was not established, and it is carried through as an
 * ABSENT `started_at` so recent-authentication gates fail closed on it.
 *
 * Read time must never stand in for it. Doing so made every projection-miss
 * read -- including one for a session started days earlier, whenever the
 * projection lagged, was reset, or was rebuilt -- report a brand-new
 * authentication moment, which silently satisfied money-surface step-up gates.
 * `updated_at` may still be approximated: nothing gates on it.
 */
function toSessionRowFromState(
  state: SessionState,
  timestamps: Readonly<{ startedAt: string | null; updatedAt: string }>,
): SessionRow | null {
  if (
    typeof state.id !== "string" ||
    state.id.length === 0 ||
    typeof state.userId !== "string" ||
    state.userId.length === 0 ||
    typeof state.accountId !== "string" ||
    state.accountId.length === 0 ||
    !Array.isArray(state.availableAccountIds) ||
    !state.availableAccountIds.every((accountId) => typeof accountId === "string" && accountId.length > 0) ||
    !state.availableAccountIds.includes(state.accountId) ||
    !isAuthMethod(state.authenticationMethod) ||
    typeof state.expiresAt !== "string" ||
    state.expiresAt.length === 0
  ) {
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
    ...(timestamps.startedAt === null ? {} : { started_at: timestamps.startedAt }),
    updated_at: timestamps.updatedAt,
  };
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return (
    value === "password" ||
    value === "magic-link" ||
    value === "passkey" ||
    value === "sms-code" ||
    isSocialLoginProviderKey(value)
  );
}

async function getSessionForAuth(services: AuthServices, sessionId: string): Promise<SessionRow | null> {
  // The Session stream is the lifecycle and account authority. Consult it
  // before an active projection can grant an actor, and fail closed before
  // identity resolution when the aggregate is absent, malformed, inactive,
  // or elapsed.
  const authenticatedSession = await services.sessions.readAuthenticatedSession(sessionId);
  if (!authenticatedSession || authenticatedSession.state.status !== "active") {
    return null;
  }

  const authoritativeSession = toSessionRowFromState(authenticatedSession.state, {
    startedAt: authenticatedSession.authenticatedAt,
    updatedAt: new Date().toISOString(),
  });
  if (!authoritativeSession || authoritativeSession.session_id !== sessionId) {
    return null;
  }

  const parsedExpiry = new Date(authoritativeSession.expires_at).getTime();
  const now = Date.now();
  if (!Number.isFinite(parsedExpiry) || parsedExpiry <= now) {
    return null;
  }

  // The projection is presentation-only on this path. It can enrich display
  // fields after aggregate authority is established, but it cannot supply or
  // override Session lifecycle, identity, account, method, or timestamps.
  const projectedSession = await services.sessions.getSession(sessionId);
  if (!projectedSession) {
    return authoritativeSession;
  }

  return {
    ...authoritativeSession,
    user_display_name: projectedSession.user_display_name,
    user_primary_email: projectedSession.user_primary_email,
    account_display_name: projectedSession.account_display_name,
    account_name: projectedSession.account_name,
  };
}

async function startSessionForUser(
  services: AuthServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: AuthMethod;
    context: EventStoreContext;
    membershipsOverride?: readonly AuthSessionMembership[];
    publishAuthenticationOutcome?: boolean;
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
  const expiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).sessionTtlMs);

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
  // The append just wrote this session's `auth.session.started` event, so the
  // last stored event's `recordedAt` IS the authoritative authentication
  // moment on this path -- unchanged by the projection-miss repair above.
  const recordedAt = storedEvents[storedEvents.length - 1]?.recordedAt ?? new Date().toISOString();
  const session = toSessionRowFromState(result.state, { startedAt: recordedAt, updatedAt: recordedAt });
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
  const selectionExpiresAt = createExpiryTimestamp(authSecurityLifetimesOf(services).accountSelectionTtlMs);

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
    publishAuthenticationOutcome?: boolean;
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

  if (params.publishAuthenticationOutcome) {
    await publishAuthenticationCsatOutcomeFact(services.eventStore, params.context, {
      subjectAccountId: sessionResult.session.account_id,
      sessionId: sessionResult.sessionId,
      outcomeOccurredAt: sessionResult.session.started_at,
    });
  }

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
  if (!session) {
    return null;
  }

  const membership = await services.identity.getActiveMembershipForUserAccount(session.user_id, session.account_id);

  if (!membership) {
    return null;
  }
  const user = await services.identity.getUser(session.user_id);
  const permissions = restrictPermissionsForUnverifiedEmail(
    resolveRolePermissions(membership.role_key, membership.role_permissions),
    user,
    session.authentication_method,
  );

  return {
    sessionId: session.session_id,
    tenantId: AUTH_BOOTSTRAP_TENANT_ID,
    userId: session.user_id,
    accountId: session.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions,
    authenticatedAt: session.started_at ?? null,
  };
}
