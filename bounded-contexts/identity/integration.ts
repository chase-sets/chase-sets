import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  MembershipId,
  SessionId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  type PermissionKey,
  type RoleKey,
  normalizeEmail,
} from "./common";
import {
  IDENTITY_BOOTSTRAP_TENANT_ID,
} from "./constants";
import { createIdentityBootstrapContext } from "./bootstrap-context";
import type { IdentityServices } from "./services";

export type { IdentityServices } from "./services";

export type IdentityIntegrationSurface = Readonly<{
  boundary: "identity-management";
}>;

export const identityIntegrationSurface: IdentityIntegrationSurface = {
  boundary: "identity-management",
};

async function drainProjectors(services: IdentityServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export type IdentityAuthMethod = "password" | "magic-link" | "passkey";

export type IdentityAuthMembership = Readonly<{
  membershipId: string;
  accountId: string;
  roleKey: string;
  status: string;
}>;

export type IdentitySessionStartResult =
  | Readonly<{
      requiresAccountSelection: true;
      memberships: readonly IdentityAuthMembership[];
    }>
  | Readonly<{
      requiresAccountSelection: false;
      sessionId: string;
      session: Awaited<ReturnType<IdentityServices["sessions"]["getSession"]>>;
      memberships: readonly IdentityAuthMembership[];
    }>;

export type IdentityAuthBridge = Readonly<{
  createBootstrapContext: () => EventStoreContext;
  normalizeEmail: typeof normalizeEmail;
  getUser: IdentityServices["users"]["getUser"];
  getUserByEmail: IdentityServices["users"]["getUserByEmail"];
  getInvitation: IdentityServices["invitations"]["getInvitation"];
  listActiveMembershipsForUser: (userId: string) => Promise<readonly IdentityAuthMembership[]>;
  createPersonalIdentity: (params: Readonly<{
    email: string;
    displayName: string;
    givenName?: string;
    familyName?: string;
    consents?: readonly { policyKey: string; policyVersion: string }[];
    context: EventStoreContext;
  }>) => Promise<Readonly<{ userId: string; accountId: string }>>;
  enablePasswordCredential: (params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>) => Promise<void>;
  registerPasskeyCredential: (params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>) => Promise<void>;
  startSessionForUser: (params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: IdentityAuthMethod;
    context: EventStoreContext;
  }>) => Promise<IdentitySessionStartResult>;
  revokeSession: (params: Readonly<{
    sessionId: string;
    context: EventStoreContext;
  }>) => Promise<Readonly<{ id: string; version: number; status: string }>>;
  acceptInvitationForUser: (params: Readonly<{
    invitationId: string;
    userId: string;
    accountId: string;
    roleKey: string;
    context: EventStoreContext;
  }>) => Promise<string>;
  resolveActorFromSessionId: (sessionId: string) => Promise<ResolvedActor | null>;
}>;

async function listActiveMembershipsForUser(
  services: IdentityServices,
  userId: string,
): Promise<readonly IdentityAuthMembership[]> {
  const memberships = await services.memberships.listMembershipsForUser(userId);
  return memberships
    .filter((membership) => membership.status === "active")
    .map((membership) => ({
      membershipId: membership.membership_id,
      accountId: membership.account_id,
      roleKey: membership.role_key,
      status: membership.status,
    }));
}

async function createPersonalIdentity(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    givenName?: string;
    familyName?: string;
    consents?: readonly { policyKey: string; policyVersion: string }[];
    context: EventStoreContext;
  }>,
) {
  const userId = createId("usr") as UserId;
  const accountId = createId("acc") as AccountId;
  const membershipId = createId("mbr") as MembershipId;

  await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: params.displayName,
      accountType: "personal",
      displayName: params.displayName,
    },
    context: params.context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName: params.displayName,
      givenName: params.givenName,
      familyName: params.familyName,
      primaryEmail: params.email,
    },
    context: params.context,
  });

  await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId,
      accountId,
      roleKey: "owner",
    },
    context: params.context,
  });

  for (const consent of params.consents ?? []) {
    const consentId = createId("cns");
    await services.consents.commandHandler({
      streamId: `identity.consent-${consentId}`,
      command: {
        type: "RecordConsent",
        consentId,
        subjectType: "user",
        userId,
        accountId,
        policyKey: consent.policyKey,
        policyVersion: consent.policyVersion,
        recordedAt: new Date().toISOString(),
      },
      context: params.context,
    });
  }

  await drainProjectors(services);
  return { userId, accountId };
}

async function startSessionForUser(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: IdentityAuthMethod;
    context: EventStoreContext;
  }>,
): Promise<IdentitySessionStartResult> {
  await drainProjectors(services);

  const memberships = await listActiveMembershipsForUser(services, params.userId);
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

  const sessionId = createId("ses") as SessionId;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();

  await services.sessions.commandHandler({
    streamId: `identity.session-${sessionId}`,
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

  await drainProjectors(services);
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

async function resolveActorFromSessionId(
  services: IdentityServices,
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

  const membership =
    await services.memberships.getActiveMembershipForUserAccount(
      session.user_id,
      session.account_id,
    );

  if (!membership) {
    return null;
  }

  return {
    sessionId: session.session_id,
    tenantId: IDENTITY_BOOTSTRAP_TENANT_ID,
    userId: session.user_id,
    accountId: session.account_id,
    membershipId: membership.membership_id,
    roleKey: membership.role_key,
    permissions: membership.role_permissions as readonly PermissionKey[],
  };
}

export function createIdentityAuthBridge(
  services: IdentityServices,
): IdentityAuthBridge {
  return {
    createBootstrapContext: createIdentityBootstrapContext,
    normalizeEmail,
    getUser: services.users.getUser,
    getUserByEmail: services.users.getUserByEmail,
    getInvitation: services.invitations.getInvitation,
    listActiveMembershipsForUser: (userId) =>
      listActiveMembershipsForUser(services, userId),
    createPersonalIdentity: (params) => createPersonalIdentity(services, params),
    enablePasswordCredential: async ({ userId, credentialId, context }) => {
      await services.users.commandHandler({
        streamId: `identity.user-${userId}`,
        command: { type: "EnableAuthMethod", authMethod: "password" },
        context,
      });
      await services.users.commandHandler({
        streamId: `identity.user-${userId}`,
        command: { type: "AttachPasswordCredential", credentialId },
        context,
      });
    },
    registerPasskeyCredential: async ({ userId, credentialId, context }) => {
      await services.users.commandHandler({
        streamId: `identity.user-${userId}`,
        command: { type: "EnableAuthMethod", authMethod: "passkey" },
        context,
      });
      await services.users.commandHandler({
        streamId: `identity.user-${userId}`,
        command: { type: "RegisterPasskeyCredential", credentialId },
        context,
      });
    },
    startSessionForUser: (params) => startSessionForUser(services, params),
    revokeSession: async ({ sessionId, context }) => {
      const result = await services.sessions.commandHandler({
        streamId: `identity.session-${sessionId}`,
        command: { type: "RevokeSession" },
        context,
      });

      return {
        id: sessionId,
        version: result.version,
        status: result.state.status,
      };
    },
    acceptInvitationForUser: async ({
      invitationId,
      userId,
      accountId,
      roleKey,
      context,
    }) => {
      const membershipId = createId("mbr") as MembershipId;
      await services.memberships.commandHandler({
        streamId: `identity.membership-${membershipId}`,
        command: {
          type: "GrantMembership",
          membershipId,
          userId: userId as UserId,
          accountId: accountId as AccountId,
          roleKey: roleKey as RoleKey,
        },
        context,
      });
      await services.invitations.commandHandler({
        streamId: `identity.invitation-${invitationId}`,
        command: {
          type: "AcceptInvitation",
          userId: userId as UserId,
        },
        context,
      });

      return membershipId;
    },
    resolveActorFromSessionId: (sessionId) =>
      resolveActorFromSessionId(services, sessionId),
  };
}
