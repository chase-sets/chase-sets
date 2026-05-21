import type { AccountId, CredentialId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import type { IdentityServices } from "./services";
import { createIdentityBootstrapContext } from "./bootstrap-context";

export type PlatformAdminBootstrapConfig = Readonly<{
  email: string;
  displayName: string;
  accountName: string;
  userId?: UserId;
  accountId?: AccountId;
  membershipId?: MembershipId;
  credentialId?: CredentialId;
}>;

export type PlatformAdminBootstrapResult = Readonly<{
  userId: UserId;
  accountId: AccountId;
  membershipId: MembershipId;
  credentialId: CredentialId;
  createdUser: boolean;
  createdAccount: boolean;
  createdMembership: boolean;
}>;

const DEFAULT_USER_ID = "usr_platform_admin" as UserId;
const DEFAULT_ACCOUNT_ID = "acc_platform_admin" as AccountId;
const DEFAULT_MEMBERSHIP_ID = "mbr_platform_admin" as MembershipId;
const DEFAULT_CREDENTIAL_ID = "crd_platform_admin_password" as CredentialId;

function splitDisplayName(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return {
    givenName: parts[0] ?? "",
    familyName: parts.slice(1).join(" "),
  };
}

async function drainIdentityProjectors(services: IdentityServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export async function bootstrapPlatformAdminIdentity(
  services: IdentityServices,
  config: PlatformAdminBootstrapConfig,
): Promise<PlatformAdminBootstrapResult> {
  const email = config.email.trim().toLowerCase();
  if (!email) {
    throw new Error("PLATFORM_ADMIN_EMAIL is required.");
  }

  const displayName = config.displayName.trim() || "Platform Admin";
  const accountName = config.accountName.trim() || "Chase Sets Platform";
  const userId = config.userId ?? DEFAULT_USER_ID;
  const accountId = config.accountId ?? DEFAULT_ACCOUNT_ID;
  const membershipId = config.membershipId ?? DEFAULT_MEMBERSHIP_ID;
  const credentialId = config.credentialId ?? DEFAULT_CREDENTIAL_ID;
  const context = createIdentityBootstrapContext();
  let createdAccount = false;
  let createdUser = false;
  let createdMembership = false;

  if (!(await services.accounts.getAccount(accountId))) {
    await services.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "CreateAccount",
        accountId,
        name: accountName,
        accountType: "business",
        displayName: accountName,
      },
      context,
    });
    createdAccount = true;
  }

  if (!(await services.users.getUser(userId))) {
    const name = splitDisplayName(displayName);
    await services.users.commandHandler({
      streamId: `identity.user-${userId}`,
      command: {
        type: "CreateUser",
        userId,
        displayName,
        givenName: name.givenName,
        familyName: name.familyName,
        primaryEmail: email,
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
    createdUser = true;
  }

  const existingMembership = await services.db.query(
    "SELECT membership_id FROM identity_memberships WHERE membership_id = $1",
    [membershipId],
  );
  if (existingMembership.rows.length === 0) {
    await services.memberships.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId,
        userId,
        accountId,
        roleKey: "platform-admin",
      },
      context,
    });
    createdMembership = true;
  }

  await drainIdentityProjectors(services);

  return {
    userId,
    accountId,
    membershipId,
    credentialId,
    createdUser,
    createdAccount,
    createdMembership,
  };
}
