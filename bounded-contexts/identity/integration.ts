import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  MembershipId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
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

export type IdentityAuthMembership = Readonly<{
  membershipId: string;
  accountId: string;
  roleKey: string;
  status: string;
}>;

export type IdentityBootstrapPort = Readonly<{
  bootstrapTenantId: string;
  createBootstrapContext: () => EventStoreContext;
  normalizeEmail: typeof normalizeEmail;
}>;

export type IdentityUserDirectoryPort = Readonly<{
  getUser: IdentityServices["users"]["getUser"];
  getUserByEmail: IdentityServices["users"]["getUserByEmail"];
}>;

export type IdentityMembershipPort = Readonly<{
  listActiveMembershipsForUser: (userId: string) => Promise<readonly IdentityAuthMembership[]>;
  getActiveMembershipForUserAccount: (
    userId: string,
    accountId: string,
  ) => ReturnType<IdentityServices["memberships"]["getActiveMembershipForUserAccount"]>;
}>;

export type IdentityInvitationPort = Readonly<{
  getInvitation: IdentityServices["invitations"]["getInvitation"];
  acceptInvitationForUser: (params: Readonly<{
    invitationId: string;
    userId: string;
    accountId: string;
    roleKey: string;
    context: EventStoreContext;
  }>) => Promise<string>;
}>;

export type IdentityProvisioningPort = Readonly<{
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

export function createIdentityBootstrapPort(
  services: IdentityServices,
): IdentityBootstrapPort {
  void services;

  return {
    bootstrapTenantId: IDENTITY_BOOTSTRAP_TENANT_ID,
    createBootstrapContext: createIdentityBootstrapContext,
    normalizeEmail,
  };
}

export function createIdentityUserDirectoryPort(
  services: IdentityServices,
): IdentityUserDirectoryPort {
  return {
    getUser: services.users.getUser,
    getUserByEmail: services.users.getUserByEmail,
  };
}

export function createIdentityMembershipPort(
  services: IdentityServices,
): IdentityMembershipPort {
  return {
    listActiveMembershipsForUser: (userId) =>
      listActiveMembershipsForUser(services, userId),
    getActiveMembershipForUserAccount: (userId, accountId) =>
      services.memberships.getActiveMembershipForUserAccount(userId, accountId),
  };
}

export function createIdentityInvitationPort(
  services: IdentityServices,
): IdentityInvitationPort {
  return {
    getInvitation: services.invitations.getInvitation,
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
      await drainProjectors(services);

      return membershipId;
    },
  };
}

export function createIdentityProvisioningPort(
  services: IdentityServices,
): IdentityProvisioningPort {
  return {
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
      await drainProjectors(services);
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
      await drainProjectors(services);
    },
  };
}
