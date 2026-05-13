import { Hono } from "hono";
import type { Context } from "hono";
import {
  hasPermission as hasActorPermission,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  ApiKeyId,
  MembershipId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import { getApiKeySecretByPrefix, upsertApiKeySecret } from "./features/api-keys/api/secret-store";
import type { PermissionKey, RoleKey } from "./support/runtime-support/common";
import type { IdentityServices } from "./support/runtime-support/services";
import { accountRoutes } from "./features/accounts/api/route";
import { userRoutes } from "./features/users/api/route";
import { membershipRoutes } from "./features/memberships/api/route";
import { invitationRoutes } from "./features/invitations/api/route";
import { apiKeyRoutes } from "./features/api-keys/api/route";
import { consentRoutes } from "./features/consents/api/route";
import { createIdentityBootstrapContext } from "./support/runtime-support/bootstrap-context";
import { buildCurrentActorDisplay } from "./support/request-support/current-actor-display";

export type IdentityApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

function hasPermission(
  actor: ResolvedActor | null | undefined,
  permission: PermissionKey,
) {
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

async function createPersonalIdentityForAuth(
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
  return { userId, accountId, membershipId };
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

  await services.accounts.commandHandler({
    streamId: `identity.account-${accountId}`,
    command: {
      type: "CreateAccount",
      accountId,
      name: displayName,
      accountType: "personal",
      displayName,
    },
    context: params.context,
  });

  await drainProjectors(services);
  return { accountId };
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

  await services.users.commandHandler({
    streamId: `identity.user-${userId}`,
    command: {
      type: "CreateUser",
      userId,
      displayName,
      primaryEmail: params.email,
    },
    context: params.context,
  });

  await drainProjectors(services);
  return { userId };
}

async function grantGuestAccountForAuth(
  services: IdentityServices,
  params: Readonly<{
    accountId: string;
    userId: string;
    roleKey: string;
    context: EventStoreContext;
  }>,
) {
  const membershipId = createId("mbr") as MembershipId;
  await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: params.accountId as AccountId,
      roleKey: params.roleKey as RoleKey,
    },
    context: params.context,
  });

  await drainProjectors(services);
  return { membershipId };
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
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "AttachPasswordCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  await drainProjectors(services);
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
  await services.users.commandHandler({
    streamId: `identity.user-${params.userId}`,
    command: {
      type: "RegisterPasskeyCredential",
      credentialId: params.credentialId,
    },
    context: params.context,
  });
  await drainProjectors(services);
}

async function acceptInvitationForUserFromAuth(
  services: IdentityServices,
  params: Readonly<{
    invitationId: string;
    userId: string;
    accountId: string;
    roleKey: string;
    context: EventStoreContext;
  }>,
) {
  const membershipId = createId("mbr") as MembershipId;
  await services.memberships.commandHandler({
    streamId: `identity.membership-${membershipId}`,
    command: {
      type: "GrantMembership",
      membershipId,
      userId: params.userId as UserId,
      accountId: params.accountId as AccountId,
      roleKey: params.roleKey as RoleKey,
    },
    context: params.context,
  });
  await services.invitations.commandHandler({
    streamId: `identity.invitation-${params.invitationId}`,
    command: {
      type: "AcceptInvitation",
      userId: params.userId as UserId,
    },
    context: params.context,
  });
  await drainProjectors(services);
  return membershipId;
}

function requirePermission(
  readPermission: PermissionKey,
  writePermission = readPermission,
) {
  return async (c: Context<IdentityApiEnv>, next: () => Promise<void>) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({
        error: {
          code: "authentication_required",
          message: "Authentication required.",
        },
      }, 401);
    }

    const requiredPermission =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? readPermission
        : writePermission;

    if (!hasPermission(actor, requiredPermission)) {
      return c.json({
        error: {
          code: "authorization_forbidden",
          message: "Forbidden.",
        },
      }, 403);
    }

    await next();
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
    const membership = await grantGuestAccountForAuth(services, {
      accountId: c.req.param("id"),
      userId: String(body.userId ?? ""),
      roleKey: String(body.roleKey ?? "owner"),
      context: getBootstrapContext(c),
    });

    return c.json(membership, 201);
  });

  app.post("/internal/auth/personal-identities", async (c) => {
    const body = await c.req.json();
    const identity = await createPersonalIdentityForAuth(services, {
      email: String(body.email ?? ""),
      displayName: String(body.displayName ?? ""),
      givenName:
        typeof body.givenName === "string" ? body.givenName : undefined,
      familyName:
        typeof body.familyName === "string" ? body.familyName : undefined,
      consents: Array.isArray(body.consents) ? body.consents : undefined,
      context: getBootstrapContext(c),
    });

    return c.json(identity, 201);
  });

  app.post("/internal/auth/users/:id/password-credential", async (c) => {
    const body = await c.req.json();
    await enablePasswordCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ ok: true });
  });

  app.post("/internal/auth/users/:id/passkey-credential", async (c) => {
    const body = await c.req.json();
    await registerPasskeyCredentialForAuth(services, {
      userId: c.req.param("id"),
      credentialId: String(body.credentialId ?? ""),
      context: getRequiredContext(c),
    });
    return c.json({ ok: true });
  });

  app.post("/internal/auth/invitations/:id/accept", async (c) => {
    const body = await c.req.json();
    const membershipId = await acceptInvitationForUserFromAuth(services, {
      invitationId: c.req.param("id"),
      userId: String(body.userId ?? ""),
      accountId: String(body.accountId ?? ""),
      roleKey: String(body.roleKey ?? ""),
      context: getBootstrapContext(c),
    });
    return c.json({ membershipId });
  });

  app.get("/current-actor-display", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({
        error: {
          code: "authentication_required",
          message: "Authentication required.",
        },
      }, 401);
    }

    const [account, membership, user] = await Promise.all([
      services.accounts.getAccount(actor.accountId),
      services.memberships.getActiveMembershipForUserAccount(
        actor.userId,
        actor.accountId,
      ),
      services.users.getUser(actor.userId),
    ]);

    return c.json(buildCurrentActorDisplay(actor, {
      account,
      membership,
      user,
    }));
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

  app.route("/accounts", accountRoutes(services.accounts));
  app.route("/users", userRoutes(services.users));
  app.route("/memberships", membershipRoutes(services.memberships));
  app.route("/invitations", invitationRoutes(services.invitations));
  app.route("/api-keys", apiKeyRoutes(services.apiKeys));
  app.route("/consents", consentRoutes(services.consents));

  app.post("/api-keys", async (c) => {
    const body = await c.req.json();
    const context = getRequiredContext(c);
    const apiKeyId = createId("key") as ApiKeyId;
    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "CreateApiKey",
        apiKeyId,
        userId: body.userId,
        name: body.name,
        keyPrefix,
      },
      context,
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId,
      userId: body.userId,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });
    await drainProjectors(services);
    return c.json({
      id: apiKeyId,
      version: result.version,
      status: result.state.status,
      secret,
      keyPrefix,
    }, 201);
  });

  app.post("/api-keys/:id/rotate", async (c) => {
    const apiKeyId = c.req.param("id");
    const apiKey = await services.apiKeys.getApiKey(apiKeyId);
    if (!apiKey) {
      return c.json({
        error: {
          code: "not_found",
          message: "API key not found.",
        },
      }, 404);
    }
    const context = getRequiredContext(c);
    const secret = services.auth.issueOpaqueToken("key");
    const keyPrefix = secret.slice(0, 12);
    const result = await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeyId}`,
      command: {
        type: "RotateApiKey",
        keyPrefix,
      },
      context,
    });
    await upsertApiKeySecret(services.db, {
      apiKeyId: apiKeyId as ApiKeyId,
      userId: apiKey.user_id,
      keyPrefix,
      secretHash: services.auth.hashSecret(secret),
    });
    await drainProjectors(services);
    return c.json({
      id: apiKeyId,
      version: result.version,
      status: result.state.status,
      secret,
      keyPrefix,
    });
  });

  app.post("/api-keys/resolve", async (c) => {
    const body = await c.req.json();
    const secret = String(body.secret ?? "");
    const keyPrefix = secret.slice(0, 12);
    const apiKeySecret = await getApiKeySecretByPrefix(services.db, keyPrefix);
    if (
      !apiKeySecret ||
      !services.auth.verifySecret(secret, apiKeySecret.secret_hash)
    ) {
      return c.json({
        error: {
          code: "authentication_required",
          message: "Invalid API key.",
        },
      }, 401);
    }
    await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeySecret.api_key_id}`,
      command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
      context: getBootstrapContext(c),
    });
    await drainProjectors(services);
    return c.json({
      apiKeyId: apiKeySecret.api_key_id,
      userId: apiKeySecret.user_id as UserId,
      keyPrefix,
    });
  });

  return app;
}
