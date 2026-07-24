import { Hono } from "hono";
import type { Context } from "hono";
import { t } from "@chase-sets/localization";
import { hasPermission as hasActorPermission, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, MembershipId, UserId } from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { publicPolicyPublicationRecords } from "@chase-sets/public-docs";
import { getApiKeySecretByPrefix } from "./features/api-keys/api/secret-store";
import {
  formatGrantableRoleKeys,
  IdentityDomainError,
  normalizeEmail,
  parseGrantableRoleKey,
  type GrantableRoleKey,
  type PermissionKey,
} from "./support/runtime-support/common";
import type { IdentityServices } from "./support/runtime-support/services";
import { accountRoutes } from "./features/accounts/api/route";
import { accessHubRoutes } from "./features/access-hub/api/route";
import { userRoutes } from "./features/users/api/route";
import { membershipRoutes } from "./features/memberships/api/route";
import { invitationRoutes } from "./features/invitations/api/route";
import { validateInvitationAcceptanceToken } from "./features/invitations/domain/domain";
import { apiKeyRoutes } from "./features/api-keys/api/route";
import { consentRoutes } from "./features/consents/api/route";
import { termsOfServiceConsentRoutes } from "./features/consents/api/terms-route";
import {
  resolveConsentBundleRequirements,
  type ConsentPublicationRegistry,
} from "./features/consents/domain/consent-activation";
import { consentBundles } from "./features/consents/domain/consent-bundle";
import { userPreferencesRoutes } from "./features/preferences/api/route";
import { shippingAddressRoutes } from "./features/shipping-addresses/api/route";
import { createIdentityBootstrapContext } from "./support/runtime-support/bootstrap-context";
import { buildCurrentActorDisplay } from "./support/shell-support/current-actor-display";
import { publishIdentityCsatOutcomeFact } from "./support/request-support/csat-outcome-facts";

export type IdentityApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

function hasPermission(actor: ResolvedActor | null | undefined, permission: PermissionKey) {
  return hasActorPermission(actor, permission);
}

export function createBootstrapContext(): EventStoreContext {
  return createIdentityBootstrapContext();
}

function getBootstrapContext(c: Context<IdentityApiEnv>) {
  return c.var.context ?? createBootstrapContext();
}

function getRequiredContext(c: Context<IdentityApiEnv>) {
  const context = c.var.context;
  if (!context) {
    throw new Error("Missing identity request context.");
  }
  return context;
}

export class IdentityDisplayNameConflictError extends Error {
  constructor() {
    super("Display name is already taken.");
    this.name = "IdentityDisplayNameConflictError";
  }
}

export function normalizeAccountDisplayNameKey(displayName: string) {
  return displayName.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

type IdentityMutationSnapshot = Readonly<{
  aggregate: "account" | "api-key" | "consent" | "invitation" | "membership" | "user";
  id: string;
  version: number;
  status: string;
}>;

function mutationSnapshot<State extends Readonly<object>>(
  aggregate: IdentityMutationSnapshot["aggregate"],
  id: string,
  result: Readonly<{ version: number; state: State }>,
  options: Readonly<{ fallbackStatus?: string }> = {},
): IdentityMutationSnapshot {
  const stateStatus = "status" in result.state ? result.state.status : undefined;

  return {
    aggregate,
    id,
    version: result.version,
    status: typeof stateStatus === "string" ? stateStatus : (options.fallbackStatus ?? "committed"),
  };
}

async function reservePersonalAccountDisplayName(
  services: IdentityServices,
  params: Readonly<{
    accountId: AccountId;
    displayName: string;
  }>,
) {
  const displayNameKey = normalizeAccountDisplayNameKey(params.displayName);
  if (!displayNameKey) {
    return;
  }

  const existingAccount = await services.db.query<{ account_id: string }>(
    `SELECT account_id
     FROM identity_accounts
     WHERE lower(regexp_replace(btrim(display_name), '[[:space:]]+', ' ', 'g')) = $1
     LIMIT 1`,
    [displayNameKey],
  );
  if (existingAccount.rows.some((row) => row.account_id !== params.accountId)) {
    throw new IdentityDisplayNameConflictError();
  }

  const reservation = await services.db.query<{ display_name_key: string }>(
    `INSERT INTO identity_account_display_name_reservations (
       display_name_key,
       account_id,
       display_name,
       created_at
     )
     VALUES ($1, $2, $3, now())
     ON CONFLICT (display_name_key) DO NOTHING
     RETURNING display_name_key`,
    [displayNameKey, params.accountId, params.displayName],
  );
  if (reservation.rows.length === 0) {
    throw new IdentityDisplayNameConflictError();
  }
}

export async function createPersonalIdentityForAuth(
  services: IdentityServices,
  params: Readonly<{
    email?: string | null;
    phone?: string | null;
    displayName: string;
    givenName?: string;
    familyName?: string;
    consentAffirmed?: boolean;
    foundersBetaAccessStartedAt?: string;
    context: EventStoreContext;
  }>,
  consentPublications: ConsentPublicationRegistry = publicPolicyPublicationRecords,
) {
  const consentRequirements = await resolveConsentBundleRequirements(
    services.policies,
    "registration",
    consentPublications,
  );
  if (consentRequirements.length > 0 && params.consentAffirmed !== true) {
    throw new IdentityDomainError(
      "Registration requires affirmation of the active Terms of Service and Privacy Policy.",
    );
  }

  const userId = createId("usr") as UserId;
  const accountId = createId("acc") as AccountId;
  const membershipId = createId("mbr") as MembershipId;
  const email = params.email?.trim() ?? "";
  const phone = params.phone?.trim() ?? "";
  const displayName = params.displayName.trim() || email || phone;
  const primaryContactMethod = phone
    ? {
        contactMethodId: createId("ctm"),
        type: "phone" as const,
        value: phone,
        verifiedAt: new Date().toISOString(),
      }
    : undefined;
  const snapshots: IdentityMutationSnapshot[] = [];

  await reservePersonalAccountDisplayName(services, {
    accountId,
    displayName,
  });

  let accountResult = await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: "",
      accountType: "personal",
      displayName,
    },
    context: params.context,
  });
  if (params.foundersBetaAccessStartedAt) {
    const betaAccessStartedAt = new Date(params.foundersBetaAccessStartedAt);
    const foundersWindowEndsAt = new Date(betaAccessStartedAt);
    foundersWindowEndsAt.setUTCDate(foundersWindowEndsAt.getUTCDate() + 60);
    accountResult = await services.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      command: {
        type: "OpenFoundersWindow",
        betaAccessStartedAt: betaAccessStartedAt.toISOString(),
        foundersWindowEndsAt: foundersWindowEndsAt.toISOString(),
        recipientEmail: email,
      },
      context: params.context,
    });
  }
  snapshots.push(mutationSnapshot("account", accountId, accountResult));

  let userResult = await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName,
      givenName: params.givenName,
      familyName: params.familyName,
      primaryEmail: email || null,
      ...(primaryContactMethod ? { primaryContactMethod } : {}),
    },
    context: params.context,
  });

  const membershipResult = await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId,
      accountId,
      roleKey: "owner",
      assignmentAuthority: { type: "system" },
    },
    context: params.context,
  });
  snapshots.push(mutationSnapshot("membership", membershipId, membershipResult));

  for (const consent of consentRequirements) {
    const consentId = createId("cns");
    const consentResult = await services.consents.commandHandler({
      streamId: `identity.consent-${consentId}`,
      command: {
        type: "RecordConsent",
        consentId,
        subjectType: consentBundles.registration.subjectType,
        userId,
        accountId,
        policyKey: consent.policyKey,
        policyVersion: consent.version,
        recordedAt: new Date().toISOString(),
      },
      context: params.context,
    });
    snapshots.push(mutationSnapshot("consent", consentId, consentResult, { fallbackStatus: "recorded" }));
  }

  if (phone) {
    userResult = await services.users.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "EnableAuthMethod", authMethod: "sms-code" },
      context: params.context,
    });
  }
  snapshots.push(mutationSnapshot("user", userId, userResult));

  if (services.eventStore) {
    await publishIdentityCsatOutcomeFact(services.eventStore, params.context, {
      outcomeCode: "registration.completed",
      subjectAccountId: accountId,
      subjectKind: "account",
      subject: { entityType: "account", entityId: accountId },
      idempotencyKey: `identity:registration:${accountId}`,
    });
  }

  return { userId, accountId, membershipId, snapshots };
}

async function createGuestAccountForAuth(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    context: EventStoreContext;
  }>,
) {
  const accountId = createId("acc") as AccountId;
  const displayName = params.displayName.trim() || params.email.trim();

  const result = await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: "",
      accountType: "personal",
      displayName,
    },
    context: params.context,
  });

  return { accountId, snapshots: [mutationSnapshot("account", accountId, result)] };
}

async function createUserForAuth(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    context: EventStoreContext;
  }>,
) {
  const userId = createId("usr") as UserId;
  const displayName = params.displayName.trim() || params.email.trim();

  const result = await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName,
      primaryEmail: params.email,
    },
    context: params.context,
  });

  return { userId, snapshots: [mutationSnapshot("user", userId, result)] };
}

async function grantGuestAccountForAuth(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    userId: string;
    roleKey: GrantableRoleKey;
    context: EventStoreContext;
  }>,
) {
  const membershipId = createId("mbr") as MembershipId;
  const result = await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: params.accountId as AccountId,
      roleKey: params.roleKey,
      assignmentAuthority: { type: "system" },
    },
    context: params.context,
  });

  if (services.eventStore) {
    await publishIdentityCsatOutcomeFact(services.eventStore, params.context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: params.accountId,
      subjectKind: "account",
      subject: { entityType: "account", entityId: params.accountId },
      idempotencyKey: `identity:onboarding:guest-account:${params.accountId}:${params.userId}`,
    });
  }

  return { membershipId, snapshots: [mutationSnapshot("membership", membershipId, result)] };
}

async function enablePasswordCredentialForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>,
) {
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "password" },
    context: params.context,
  });
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function registerPasskeyCredentialForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    credentialId: string;
    context: EventStoreContext;
  }>,
) {
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "passkey" },
    context: params.context,
  });
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "RegisterPasskeyCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function enableSmsCodeForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    context: EventStoreContext;
  }>,
) {
  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "sms-code" },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

class SocialLoginLinkConflictError extends Error {
  constructor() {
    super("Social login is already linked to another user.");
  }
}

function roleKeyValidationError() {
  return {
    error: {
      code: "validation_failed",
      message: `Role key is invalid. Valid role keys: ${formatGrantableRoleKeys()}.`,
    },
  };
}

async function linkSocialLoginForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    providerName: "google" | "facebook";
    providerSubject: string;
    email: string;
    context: EventStoreContext;
  }>,
) {
  const existingLink = await services.users.getUserBySocialLogin({
    providerName: params.providerName,
    providerSubject: params.providerSubject,
  });

  if (existingLink && existingLink.user_id !== params.userId) {
    throw new SocialLoginLinkConflictError();
  }

  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: { type: "EnableAuthMethod", authMethod: "social-login" },
    context: params.context,
  });

  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "LinkSocialLogin",
      providerName: params.providerName,
      providerSubject: params.providerSubject,
      email: params.email,
      linkedAt: new Date().toISOString(),
    },
    context: params.context,
  });
  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function verifyEmailContactMethodForAuth(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    email: string;
    context: EventStoreContext;
  }>,
) {
  const user = await services.users.getUserState(params.userId);
  const email = normalizeEmail(params.email);
  const contactMethod = user?.contactMethods.find((method) => method.type === "email" && method.value === email);
  if (!contactMethod) {
    return { userId: params.userId, snapshots: [] };
  }
  if (contactMethod.verifiedAt) {
    return { userId: params.userId, snapshots: [] };
  }

  const result = await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "VerifyContactMethod",
      contactMethodId: contactMethod.contactMethodId,
      verifiedAt: new Date().toISOString(),
    },
    context: params.context,
  });

  return { userId: params.userId, snapshots: [mutationSnapshot("user", params.userId, result)] };
}

async function acceptInvitationForUserFromAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    userId: string;
    acceptanceTokenHash: string;
    context: EventStoreContext;
  }>,
) {
  const invitation = await services.invitations.getInvitationState(params.invitationId);
  const acceptedAt = new Date().toISOString();
  if (!invitation?.id || !invitation.accountId || !invitation.roleKey || !invitation.email) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }
  validateInvitationAcceptanceToken(invitation, params.acceptanceTokenHash, acceptedAt);
  const roleKey = parseGrantableRoleKey(invitation.roleKey);
  if (!roleKey) {
    throw new IdentityDomainError("Platform-admin can only be assigned by platform bootstrap.");
  }

  const invitationResult = await services.invitations.commandHandler({
    streamId: `identity.invitation-${params.invitationId}`,
    command: {
      type: "AcceptInvitation",
      userId: params.userId as UserId,
      acceptanceTokenHash: params.acceptanceTokenHash,
      acceptedAt,
    },
    context: params.context,
  });
  const membershipId = createId("mbr") as MembershipId;
  const membershipResult = await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: invitation.accountId,
      roleKey,
      assignmentAuthority: { type: "system" },
    },
    context: params.context,
  });
  if (services.eventStore) {
    await publishIdentityCsatOutcomeFact(services.eventStore, params.context, {
      outcomeCode: "onboarding.completed",
      subjectAccountId: invitation.accountId,
      subjectKind: "account",
      subject: { entityType: "invitation", entityId: params.invitationId },
      idempotencyKey: `identity:onboarding:invitation:${params.invitationId}:${params.userId}`,
    });
  }
  return {
    membershipId,
    snapshots: [
      mutationSnapshot("invitation", params.invitationId, invitationResult),
      mutationSnapshot("membership", membershipId, membershipResult),
    ],
  };
}

async function requirePendingInvitationForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
  }>,
) {
  const invitation = await services.invitations.getInvitationState(params.invitationId);
  if (
    !invitation?.id ||
    !invitation.accountId ||
    !invitation.email ||
    !invitation.roleKey ||
    !invitation.expiresAt ||
    invitation.status !== "pending"
  ) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }

  if (Date.parse(invitation.expiresAt) <= Date.now()) {
    throw new IdentityDomainError("Invitation is unavailable.");
  }

  return invitation;
}

async function issueInvitationAcceptanceTokenForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    tokenHash: string;
    expiresAt: string;
    context: EventStoreContext;
  }>,
) {
  const invitation = await requirePendingInvitationForAuth(services, params);
  const result = await services.invitations.commandHandler({
    streamId: `identity.invitation-${params.invitationId}`,
    command: {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
    },
    context: params.context,
  });

  return {
    invitationId: params.invitationId,
    accountId: invitation.accountId,
    email: invitation.email,
    roleKey: invitation.roleKey,
    expiresAt: params.expiresAt,
    snapshots: [mutationSnapshot("invitation", params.invitationId, result)],
  };
}

async function verifyInvitationAcceptanceTokenForAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    acceptanceTokenHash: string;
  }>,
) {
  const invitation = await requirePendingInvitationForAuth(services, params);
  validateInvitationAcceptanceToken(invitation, params.acceptanceTokenHash, new Date().toISOString());

  return {
    invitationId: params.invitationId,
    accountId: invitation.accountId,
    email: invitation.email,
    roleKey: invitation.roleKey,
    expiresAt: invitation.expiresAt,
  };
}

function requirePermission(readPermission: PermissionKey, writePermission = readPermission) {
  return async (c: Context<IdentityApiEnv>, next: () => Promise<void>) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }

    const requiredPermission = c.req.method === "GET" || c.req.method === "HEAD" ? readPermission : writePermission;

    if (!hasPermission(actor, requiredPermission)) {
      return c.json(
        {
          error: {
            code: "authorization_forbidden",
            message: "Forbidden.",
          },
        },
        403,
      );
    }

    await next();
  };
}

async function getCurrentActorMembershipDisplay(services: IdentityServices, actor: ResolvedActor) {
  const projected = await services.memberships.getActiveMembershipForUserAccount(actor.userId, actor.accountId);
  if (projected) {
    return projected;
  }

  const state = await services.memberships.getMembershipState(actor.membershipId);
  if (
    state?.status !== "active" ||
    state.userId !== actor.userId ||
    state.accountId !== actor.accountId ||
    !state.id ||
    !state.roleKey
  ) {
    return null;
  }

  return {
    membership_id: state.id,
    role_key: state.roleKey,
  };
}

export function buildIdentityApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();

  app.post("/internal/auth/guest-accounts", async (c) => {
    const body = await c.req.json();
    const account = await createGuestAccountForAuth(services, {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      context: getBootstrapContext(c),
    });

    return c.json(account, 201);
  });

  app.post("/internal/auth/users", async (c) => {
    const body = await c.req.json();
    const user = await createUserForAuth(services, {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      context: getBootstrapContext(c),
    });

    return c.json(user, 201);
  });

  app.post("/internal/auth/guest-accounts/:id/claim", async (c) => {
    const body = await c.req.json();
    const roleKey = parseGrantableRoleKey(body.roleKey ?? "owner");
    if (!roleKey) {
      return c.json(roleKeyValidationError(), 400);
    }
    const membership = await grantGuestAccountForAuth(services, {
      accountId: c.req.param("id"),
      userId: String(body.userId ?? ""),
      roleKey,
      context: getBootstrapContext(c),
    });

    return c.json(membership, 201);
  });

  app.post("/internal/auth/personal-identities", async (c) => {
    const body = await c.req.json();
    let identity: Awaited<ReturnType<typeof createPersonalIdentityForAuth>>;
    try {
      identity = await createPersonalIdentityForAuth(services, {
        email: typeof body.email === "string" && body.email.trim() ? body.email : null,
        phone: typeof body.phone === "string" && body.phone.trim() ? body.phone : null,
        displayName: String(body.displayName ?? ""),
        givenName: typeof body.givenName === "string" ? body.givenName : undefined,
        familyName: typeof body.familyName === "string" ? body.familyName : undefined,
        consentAffirmed: body.consentAffirmed === true,
        foundersBetaAccessStartedAt:
          typeof body.foundersBetaAccessStartedAt === "string" ? body.foundersBetaAccessStartedAt : undefined,
        context: getBootstrapContext(c),
      });
    } catch (error) {
      if (error instanceof IdentityDisplayNameConflictError) {
        return c.json(
          {
            error: {
              code: "display_name_already_taken",
              message: t("identity.api.display.name.already.taken"),
            },
          },
          409,
        );
      }

      throw error;
    }

    return c.json(identity, 201);
  });

  app.post("/internal/auth/users/:id/sms-code", async (c) => {
    const credential = await enableSmsCodeForAuth(services, {
      userId: c.req.param("id"),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/password-credential", async (c) => {
    const body = await c.req.json();
    const credential = await enablePasswordCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/passkey-credential", async (c) => {
    const body = await c.req.json();
    const credential = await registerPasskeyCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...credential });
  });

  app.post("/internal/auth/users/:id/social-login-link", async (c) => {
    const body = await c.req.json();
    const providerName = String(body.providerName ?? "");
    if (providerName !== "google" && providerName !== "facebook") {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: "Social login provider is unsupported.",
          },
        },
        400,
      );
    }

    try {
      const link = await linkSocialLoginForAuth(services, {
        userId: c.req.param("id"),
        providerName,
        providerSubject: String(body.providerSubject ?? ""),
        email: String(body.email ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json({ ok: true, ...link });
    } catch (error) {
      if (error instanceof SocialLoginLinkConflictError) {
        return c.json(
          {
            error: {
              code: "social_login_already_linked",
              message: "Social login is already linked to another user.",
            },
          },
          409,
        );
      }

      throw error;
    }
  });

  app.post("/internal/auth/users/:id/email-verification", async (c) => {
    const body = await c.req.json();
    const verification = await verifyEmailContactMethodForAuth(services, {
      userId: c.req.param("id"),
      email: String(body.email ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true, ...verification });
  });

  app.post("/internal/auth/invitations/:id/accept", async (c) => {
    const body = await c.req.json();
    try {
      const membership = await acceptInvitationForUserFromAuth(services, {
        invitationId: c.req.param("id"),
        userId: String(body.userId ?? ""),
        acceptanceTokenHash: String(body.acceptanceTokenHash ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json(membership);
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.post("/internal/auth/invitations/:id/acceptance-token", async (c) => {
    const body = await c.req.json();
    try {
      const token = await issueInvitationAcceptanceTokenForAuth(services, {
        invitationId: c.req.param("id"),
        tokenHash: String(body.tokenHash ?? ""),
        expiresAt: String(body.expiresAt ?? ""),
        context: getBootstrapContext(c),
      });
      return c.json(token);
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.post("/internal/auth/invitations/:id/verify-acceptance-token", async (c) => {
    const body = await c.req.json();
    try {
      return c.json(
        await verifyInvitationAcceptanceTokenForAuth(services, {
          invitationId: c.req.param("id"),
          acceptanceTokenHash: String(body.acceptanceTokenHash ?? ""),
        }),
      );
    } catch (error) {
      if (error instanceof IdentityDomainError && error.message === "Invitation is unavailable.") {
        return c.json({ error: { code: "not_found", message: "Invitation is unavailable." } }, 404);
      }
      if (error instanceof IdentityDomainError) {
        return c.json({ error: { code: "authorization_forbidden", message: error.message } }, 403);
      }

      throw error;
    }
  });

  app.get("/current-actor-display", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required.",
          },
        },
        401,
      );
    }

    const [account, membership, projectedUser, userState] = await Promise.all([
      services.accounts.getAccountForRead(actor.accountId),
      getCurrentActorMembershipDisplay(services, actor),
      services.users.getUser(actor.userId),
      services.users.getUserState(actor.userId),
    ]);
    const user = userState
      ? {
          user_id: actor.userId,
          display_name: userState.displayName || projectedUser?.display_name || null,
          primary_email: userState.primaryEmail ?? projectedUser?.primary_email ?? null,
        }
      : projectedUser;

    return c.json(
      buildCurrentActorDisplay(actor, {
        account,
        membership,
        user,
      }),
    );
  });

  app.use("/accounts", requirePermission("accounts.view", "accounts.manage"));
  app.use("/accounts/*", requirePermission("accounts.view", "accounts.manage"));
  app.use("/users", requirePermission("security.manage"));
  app.use("/users/*", requirePermission("security.manage"));
  app.use("/memberships", requirePermission("memberships.view", "memberships.manage"));
  app.use("/memberships/*", requirePermission("memberships.view", "memberships.manage"));
  app.use("/invitations", requirePermission("memberships.manage"));
  app.use("/invitations/*", requirePermission("memberships.manage"));
  app.use("/api-keys", requirePermission("security.manage"));
  app.use("/api-keys/*", requirePermission("security.manage"));
  app.use("/access-hub", requirePermission("accounts.view"));
  app.use("/access-hub/*", requirePermission("accounts.view"));

  app.route("/access-hub", accessHubRoutes(services.accessHub));
  app.route("/accounts", accountRoutes(services.accounts));
  app.route("/accounts/:accountId/shipping-addresses", shippingAddressRoutes(services.shippingAddresses));
  app.route("/users", userRoutes(services.users));
  app.route("/memberships", membershipRoutes(services.memberships, services.accounts));
  app.route("/invitations", invitationRoutes(services.invitations, services.accounts));
  app.route(
    "/api-keys",
    apiKeyRoutes({ ...services.apiKeys, db: services.db, auth: services.auth, getUser: services.users.getUser }),
  );
  app.route("/consents", consentRoutes(services.consents));
  app.route(
    "/consents/terms-of-service",
    termsOfServiceConsentRoutes({
      db: services.db,
      policies: services.policies,
      consents: services.consents,
      consentPublications: publicPolicyPublicationRecords,
    }),
  );
  app.route("/preferences", userPreferencesRoutes(services.preferences));

  app.post("/api-keys/resolve", async (c) => {
    const body = await c.req.json();
    const secret = String(body.secret ?? "");
    const keyPrefix = secret.slice(0, 12);
    const apiKeySecret = await getApiKeySecretByPrefix(services.db, keyPrefix);
    if (!apiKeySecret || !services.auth.verifySecret(secret, apiKeySecret.secret_hash)) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: "Invalid API key.",
          },
        },
        401,
      );
    }
    let result: Awaited<ReturnType<IdentityServices["apiKeys"]["commandHandler"]>>;
    try {
      result = await services.apiKeys.commandHandler({
        streamId: `identity.api-key-${apiKeySecret.api_key_id}`,
        command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
        context: getBootstrapContext(c),
      });
    } catch (error) {
      if (error instanceof IdentityDomainError) {
        return c.json(
          {
            error: {
              code: "authentication_required",
              message: "Invalid API key.",
            },
          },
          401,
        );
      }
      throw error;
    }
    return c.json({
      apiKeyId: apiKeySecret.api_key_id,
      userId: apiKeySecret.user_id as UserId,
      keyPrefix,
      version: result.version,
      status: result.state.status,
    });
  });

  return app;
}

export function buildIdentityPublicApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();
  app.get("/founders-cohort", async (c) => c.json(await services.foundersCohort.getCount()));
  return app;
}
