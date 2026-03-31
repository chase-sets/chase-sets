import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { demoIdentitySeedIds } from "@chase-sets/dev-seeds";
import { createIdentityServices } from "./services";
import { createBootstrapContext } from "./api";
import { upsertPasswordCredential } from "./auth-support/store";

export async function seedIdentityDatabase(pool: PgTransactionalPool) {
  const services = createIdentityServices(pool);
  const context = createBootstrapContext();
  const {
    accountId,
    consentId,
    credentialId,
    membershipId,
    userId,
  } = demoIdentitySeedIds;

  await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: "Demo Account",
      accountType: "business",
      displayName: "Demo Account",
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName: "Demo User",
      primaryEmail: "demo@chasesets.test",
      givenName: "Demo",
      familyName: "User",
    },
    context,
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
    context,
  });

  await services.consents.commandHandler({
    streamId: `identity.consent-${consentId}`,
    command: {
      type: "RecordConsent",
      consentId,
      subjectType: "user",
      userId,
      accountId,
      policyKey: "terms-of-service",
      policyVersion: "v1",
      recordedAt: new Date().toISOString(),
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "EnableAuthMethod",
      authMethod: "password",
    },
    context,
  });

  await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId,
    },
    context,
  });

  await upsertPasswordCredential(services.db, {
    credentialId,
    userId,
    secretHash: services.auth.hashSecret("demo1234"),
  });
}
