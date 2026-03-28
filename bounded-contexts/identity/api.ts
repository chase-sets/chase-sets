import { Hono } from "hono";
import type { Context } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  ApiKeyId,
  CommandId,
  CorrelationId,
  MembershipId,
  SessionId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  consumeAccountSelectionToken,
  getApiKeySecretByPrefix,
  getAccountSelectionTokenByHash,
  getPasswordCredentialByUserId,
  getPasskeyCredentialByExternalId,
  insertChallenge,
  insertAccountSelectionToken,
  insertMagicLinkToken,
  upsertApiKeySecret,
  upsertPasskeyCredential,
  upsertPasswordCredential,
  upsertSessionToken,
  consumeChallenge,
  consumeMagicLinkToken,
} from "./auth-support/store";
import {
  IDENTITY_BOOTSTRAP_ACCOUNT_ID,
  IDENTITY_BOOTSTRAP_TENANT_ID,
  IDENTITY_BOOTSTRAP_USER_ID,
} from "./constants";
import {
  assert,
  normalizeEmail,
  type PermissionKey,
  type RoleKey,
} from "./common";
import type { IdentityServices } from "./services";
import {
  hasPermission,
  type ResolvedActor,
} from "./server";
import { accountRoutes } from "./accounts/route";
import { userRoutes } from "./users/route";
import { membershipRoutes } from "./memberships/route";
import { invitationRoutes } from "./invitations/route";
import { sessionRoutes } from "./sessions/route";
import { apiKeyRoutes } from "./api-keys/route";
import { consentRoutes } from "./consents/route";

export type IdentityApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor | null;
  };
};

export function createBootstrapContext(): EventStoreContext {
  return {
    tenantId: IDENTITY_BOOTSTRAP_TENANT_ID as never,
    audit: {
      performedByUserId: IDENTITY_BOOTSTRAP_USER_ID as never,
      forAccountId: IDENTITY_BOOTSTRAP_ACCOUNT_ID as never,
    },
    trace: {
      correlationId: createId("cor") as CorrelationId,
      commandId: createId("cmd") as CommandId,
    },
  };
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

function getRequiredActor(c: Context<IdentityApiEnv>) {
  const actor = c.var.actor;
  if (!actor) {
    throw new Error("Missing identity actor.");
  }
  return actor;
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

async function createPersonalIdentity(
  services: IdentityServices,
  params: Readonly<{
    email: string;
    displayName: string;
    password?: string;
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

  if (params.password) {
    const credentialId = createId("crd");
    await services.users.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "EnableAuthMethod", authMethod: "password" },
      context: params.context,
    });
    await services.users.commandHandler({
      streamId: `identity.user-${userId}`,
      command: { type: "AttachPasswordCredential", credentialId },
      context: params.context,
    });
    await upsertPasswordCredential(services.db, {
      credentialId,
      userId,
      secretHash: services.auth.hashSecret(params.password),
    });
  }

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

async function resolveMemberships(services: IdentityServices, userId: string) {
  const memberships = await services.memberships.listMembershipsForUser(userId);
  return memberships.filter((membership) => membership.status === "active");
}

async function createPendingAccountSelection(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
  }>,
) {
  const tokenId = createId("cmd");
  const selectionToken = services.auth.issueOpaqueToken("acct");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 10).toISOString();

  await insertAccountSelectionToken(services.db, {
    tokenId,
    userId: params.userId,
    authenticationMethod: params.authenticationMethod,
    tokenHash: services.auth.hashSecret(selectionToken),
    expiresAt,
  });

  return {
    selectionToken,
    expiresAt,
  };
}

async function toInteractiveAuthResponse(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
    sessionResult: Awaited<ReturnType<typeof startSessionForUser>>;
  }>,
) {
  if (!params.sessionResult.requiresAccountSelection) {
    return params.sessionResult;
  }

  const selection = await createPendingAccountSelection(services, {
    userId: params.userId,
    authenticationMethod: params.authenticationMethod,
  });

  return {
    ...params.sessionResult,
    selectionToken: selection.selectionToken,
    selectionExpiresAt: selection.expiresAt,
  };
}

function requirePermission(
  readPermission: PermissionKey,
  writePermission = readPermission,
) {
  return async (c: Context<IdentityApiEnv>, next: () => Promise<void>) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const requiredPermission =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? readPermission
        : writePermission;

    if (!hasPermission(actor, requiredPermission)) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();
  };
}

async function startSessionForUser(
  services: IdentityServices,
  params: Readonly<{
    userId: string;
    accountId?: string;
    authenticationMethod: "password" | "magic-link" | "passkey";
    context: EventStoreContext;
  }>,
) {
  const memberships = await resolveMemberships(services, params.userId);
  if (memberships.length === 0) {
    throw new Error("User has no active memberships.");
  }

  const selectedAccountId =
    params.accountId ??
    (memberships.length === 1 ? memberships[0].account_id : undefined);

  if (!selectedAccountId) {
    return {
      requiresAccountSelection: true,
      memberships: memberships.map((membership) => ({
        membershipId: membership.membership_id,
        accountId: membership.account_id,
        roleKey: membership.role_key,
        status: membership.status,
      })),
    } as const;
  }

  const availableAccountIds = memberships.map((membership) => membership.account_id);
  assert(
    availableAccountIds.includes(selectedAccountId),
    "Selected account is not available for this user.",
  );
  const sessionId = createId("ses") as SessionId;
  const sessionToken = services.auth.issueOpaqueToken("session");
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

  await upsertSessionToken(services.db, {
    sessionId,
    tokenHash: services.auth.hashSecret(sessionToken),
    expiresAt,
  });

  await drainProjectors(services);

  const session = await services.sessions.getSession(sessionId);

  return {
    requiresAccountSelection: false,
    sessionToken,
    session,
    memberships: memberships.map((membership) => ({
      membershipId: membership.membership_id,
      accountId: membership.account_id,
      roleKey: membership.role_key,
      status: membership.status,
    })),
  } as const;
}

export function buildIdentityApi(services: IdentityServices) {
  const app = new Hono<IdentityApiEnv>();

  const auth = new Hono<IdentityApiEnv>();

  auth.post("/register", async (c) => {
    const body = await c.req.json();
    const email = normalizeEmail(body.email);
    const existingUser = await services.users.getUserByEmail(email);
    if (existingUser) {
      return c.json({ error: "A user already exists for that email." }, 409);
    }

    const context = getBootstrapContext(c);
    const identity = await createPersonalIdentity(services, {
      email,
      displayName: body.displayName,
      givenName: body.givenName,
      familyName: body.familyName,
      password: body.password,
      consents: body.consents,
      context,
    });

    const sessionResult = await startSessionForUser(services, {
      userId: identity.userId,
      accountId: identity.accountId,
      authenticationMethod: body.password ? "password" : "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: identity.userId,
      authenticationMethod: body.password ? "password" : "magic-link",
      sessionResult,
    });

    return c.json({
      userId: identity.userId,
      accountId: identity.accountId,
      ...authResponse,
    }, 201);
  });

  auth.post("/password-sign-in", async (c) => {
    const body = await c.req.json();
    const email = normalizeEmail(body.email);
    const user = await services.users.getUserByEmail(email);
    if (!user) {
      return c.json({ error: "Invalid email or password." }, 401);
    }
    const passwordCredential = await getPasswordCredentialByUserId(services.db, user.user_id);
    if (
      !passwordCredential ||
      !services.auth.verifySecret(body.password, passwordCredential.secret_hash)
    ) {
      return c.json({ error: "Invalid email or password." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: user.user_id,
      accountId: body.accountId,
      authenticationMethod: "password",
      context: getBootstrapContext(c),
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user.user_id,
      authenticationMethod: "password",
      sessionResult,
    });

    return c.json({
      userId: user.user_id,
      ...authResponse,
    });
  });

  auth.post("/magic-link/request", async (c) => {
    const body = await c.req.json();
    const email = normalizeEmail(body.email);
    const user = await services.users.getUserByEmail(email);
    const tokenId = createId("cmd");
    const token = services.auth.issueOpaqueToken("magic");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15).toISOString();
    await insertMagicLinkToken(services.db, {
      tokenId,
      userId: user?.user_id ?? null,
      email,
      tokenHash: services.auth.hashSecret(token),
      expiresAt,
    });
    return c.json({ tokenId, token, expiresAt });
  });

  auth.post("/magic-link/consume", async (c) => {
    const body = await c.req.json();
    const record = await consumeMagicLinkToken(
      services.db,
      services.auth.hashSecret(body.token),
    );
    if (!record) {
      return c.json({ error: "Magic link is invalid or has expired." }, 401);
    }

    let user = record.user_id
      ? await services.users.getUser(record.user_id)
      : await services.users.getUserByEmail(record.email);

    const context = getBootstrapContext(c);
    if (!user) {
      const identity = await createPersonalIdentity(services, {
        email: record.email,
        displayName: record.email.split("@")[0],
        context,
      });
      user = await services.users.getUser(identity.userId);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: user!.user_id,
      accountId: body.accountId,
      authenticationMethod: "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user!.user_id,
      authenticationMethod: "magic-link",
      sessionResult,
    });

    return c.json({
      userId: user!.user_id,
      ...authResponse,
    });
  });

  auth.post("/account-selection/resolve", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await getAccountSelectionTokenByHash(
      services.db,
      services.auth.hashSecret(selectionToken),
    );

    if (!selection) {
      return c.json({ error: "Account selection is invalid or has expired." }, 401);
    }

    const memberships = await resolveMemberships(services, selection.user_id);
    return c.json({
      userId: selection.user_id,
      memberships: memberships.map((membership) => ({
        membershipId: membership.membership_id,
        accountId: membership.account_id,
        roleKey: membership.role_key,
        status: membership.status,
      })),
    });
  });

  auth.post("/account-selection/complete", async (c) => {
    const body = await c.req.json();
    const selectionToken = String(body.selectionToken ?? "");
    const selection = await consumeAccountSelectionToken(
      services.db,
      services.auth.hashSecret(selectionToken),
    );

    if (!selection) {
      return c.json({ error: "Account selection is invalid or has expired." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: selection.user_id,
      accountId: body.accountId,
      authenticationMethod: selection.authentication_method as
        | "password"
        | "magic-link"
        | "passkey",
      context: getBootstrapContext(c),
    });

    if (sessionResult.requiresAccountSelection) {
      return c.json({ error: "Account selection could not be completed." }, 400);
    }

    return c.json({
      userId: selection.user_id,
      ...sessionResult,
    });
  });

  auth.post("/passkeys/challenge", async (c) => {
    const body = await c.req.json();
    const challengeId = createId("cmd");
    const challengeValue = services.auth.issueChallenge();
    const email = body.email ? normalizeEmail(body.email) : null;
    const user = email ? await services.users.getUserByEmail(email) : null;
    await insertChallenge(services.db, {
      challengeId,
      purpose: body.purpose,
      email,
      userId: user?.user_id ?? null,
      challengeValue,
      expiresAt: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
    });
    return c.json({ challengeId, challenge: challengeValue });
  });

  auth.post("/passkeys/register", async (c) => {
    const body = await c.req.json();
    const challenge = await consumeChallenge(services.db, {
      challengeId: body.challengeId,
      purpose: "passkey-register",
      challengeValue: body.challenge,
    });
    if (!challenge) {
      return c.json({ error: "Passkey challenge is invalid or expired." }, 401);
    }

    const actor = getRequiredActor(c);
    const context = getRequiredContext(c);
    const userId = (body.userId ?? challenge.user_id ?? actor.userId) as
      | UserId
      | undefined;
    if (!userId) {
      return c.json({ error: "Passkey registration requires a user." }, 400);
    }

    const credentialId = createId("crd");
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
    await upsertPasskeyCredential(services.db, {
      credentialId,
      userId,
      externalCredentialId: body.externalCredentialId,
      label: body.label,
      publicKey: body.publicKey,
    });
    await services.db.query(
      `INSERT INTO identity_passkey_lookup (
         external_credential_id,
         credential_id,
         user_id,
         label,
         updated_at
       )
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (external_credential_id) DO UPDATE
       SET credential_id = $2,
           user_id = $3,
           label = $4,
           updated_at = now()`,
      [body.externalCredentialId, credentialId, userId, body.label],
    );
    await drainProjectors(services);
    return c.json({ credentialId, userId }, 201);
  });

  auth.post("/passkeys/sign-in", async (c) => {
    const body = await c.req.json();
    const challenge = await consumeChallenge(services.db, {
      challengeId: body.challengeId,
      purpose: "passkey-sign-in",
      challengeValue: body.challenge,
    });
    if (!challenge) {
      return c.json({ error: "Passkey challenge is invalid or expired." }, 401);
    }

    const passkey = await getPasskeyCredentialByExternalId(
      services.db,
      body.externalCredentialId,
    );
    if (!passkey) {
      return c.json({ error: "Unknown passkey credential." }, 401);
    }

    const sessionResult = await startSessionForUser(services, {
      userId: passkey.user_id,
      accountId: body.accountId,
      authenticationMethod: "passkey",
      context: getBootstrapContext(c),
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: passkey.user_id,
      authenticationMethod: "passkey",
      sessionResult,
    });

    return c.json({
      userId: passkey.user_id,
      ...authResponse,
    });
  });

  auth.post("/invitations/accept", async (c) => {
    const body = await c.req.json();
    const invitation = await services.invitations.getInvitation(body.invitationId);
    if (!invitation || invitation.status !== "pending") {
      return c.json({ error: "Invitation is unavailable." }, 404);
    }

    const context = getBootstrapContext(c);
    let user = await services.users.getUserByEmail(invitation.email);
    if (!user) {
      const identity = await createPersonalIdentity(services, {
        email: invitation.email,
        displayName: invitation.email.split("@")[0],
        password: body.password,
        context,
      });
      user = await services.users.getUser(identity.userId);
    }

    const membershipId = createId("mbr") as MembershipId;
    await services.memberships.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      command: {
        type: "GrantMembership",
        membershipId,
        userId: user!.user_id as UserId,
        accountId: invitation.account_id as AccountId,
        roleKey: invitation.role_key as RoleKey,
      },
      context,
    });
    await services.invitations.commandHandler({
      streamId: `identity.invitation-${body.invitationId}`,
      command: {
        type: "AcceptInvitation",
        userId: user!.user_id as UserId,
      },
      context,
    });
    await drainProjectors(services);

    const sessionResult = await startSessionForUser(services, {
      userId: user!.user_id,
      accountId: invitation.account_id,
      authenticationMethod: body.password ? "password" : "magic-link",
      context,
    });
    const authResponse = await toInteractiveAuthResponse(services, {
      userId: user!.user_id,
      authenticationMethod: body.password ? "password" : "magic-link",
      sessionResult,
    });

    return c.json({
      invitationId: body.invitationId,
      membershipId,
      userId: user!.user_id,
      ...authResponse,
    });
  });

  auth.get("/session", async (c) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    return c.json({ actor });
  });

  app.use("/accounts", requirePermission("accounts.view", "accounts.manage"));
  app.use("/accounts/*", requirePermission("accounts.view", "accounts.manage"));
  app.use("/users", requirePermission("security.manage"));
  app.use("/users/*", requirePermission("security.manage"));
  app.use("/memberships", requirePermission("memberships.view", "memberships.manage"));
  app.use("/memberships/*", requirePermission("memberships.view", "memberships.manage"));
  app.use("/invitations", requirePermission("memberships.manage"));
  app.use("/invitations/*", requirePermission("memberships.manage"));
  app.use("/sessions", requirePermission("security.manage"));
  app.use("/sessions/*", requirePermission("security.manage"));
  app.use("/api-keys", requirePermission("security.manage"));
  app.use("/api-keys/*", requirePermission("security.manage"));

  app.route("/accounts", accountRoutes(services.accounts));
  app.route("/users", userRoutes(services.users));
  app.route("/memberships", membershipRoutes(services.memberships));
  app.route("/invitations", invitationRoutes(services.invitations));
  app.route("/sessions", sessionRoutes(services.sessions));
  app.route("/api-keys", apiKeyRoutes(services.apiKeys));
  app.route("/consents", consentRoutes(services.consents));
  app.route("/auth", auth);

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
      return c.json({ error: "API key not found." }, 404);
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
      return c.json({ error: "Invalid API key." }, 401);
    }
    await services.apiKeys.commandHandler({
      streamId: `identity.api-key-${apiKeySecret.api_key_id}`,
      command: { type: "RecordApiKeyUse", usedAt: new Date().toISOString() },
      context: getBootstrapContext(c),
    });
    await drainProjectors(services);
    return c.json({
      apiKeyId: apiKeySecret.api_key_id,
      userId: apiKeySecret.user_id,
      keyPrefix,
    });
  });

  return app;
}
