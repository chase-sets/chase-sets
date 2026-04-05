import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  type AccountId,
  type MembershipId,
  type UserId,
  createId,
} from "@chase-sets/primitives/typed-ids";
import type { IdentityServices } from "../services";

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
